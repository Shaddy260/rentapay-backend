// src/controllers/utilitySubmetering.controller.js
//
// Utility Sub-Metering - see RentaPay-Utility-Submetering-Spec.pdf.
// Sections 1-7 end to end:
//   1. Meter reading submission (individual meters) + duplicate guard
//   2. Baseline entry + mandatory-reason corrections
//   3. Individual usage calculation + anomaly warning
//   4. Shared meter occupied-unit detection
//   5. Shared meter proportional split
//   6. Review screen - overrides (occupied-days or amount), each with
//      a mandatory reason, live recalculation, draft-only (nothing
//      tenant-facing yet)
//   7. Final submission - locks amounts, appends to invoices (via the
//      same one-time-charge-onto-balance_due mechanism unit.controller
//      already uses), notifies tenants, sets new baseline
//
// Access: caretaker, manager, or landlord may submit/correct readings
// and work the review screen (per the spec, all three roles can do
// all of Sections 1-6). Ownership/property-access is still checked on
// every write, same as the rest of the app.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { captureException } = require('../services/sentry.service');
const { logActivity } = require('../services/activityLog.service');
const { notify } = require('../services/notify.service');
const { checkLandlordOwnership, checkManagerPropertyAccess, effectiveLandlordId } = require('../middleware/auth.middleware');
const svc = require('../services/utilitySubmetering.service');

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentActor(req) {
  const role = req.user.role === 'manager' && req.user.roleLevel === 'caretaker' ? 'caretaker' : req.user.role;
  return { role, id: req.user.id };
}

// ---------------------------------------------------------------------
// Meters - setup (not its own numbered section, but the prerequisite
// object every reading hangs off of).
// ---------------------------------------------------------------------

async function createMeter(req, res) {
  try {
    const { propertyId, label, utilityType, isShared, ratePerUnit, unitIds } = req.body;
    if (!label || !utilityType || !['water', 'electricity'].includes(utilityType)) {
      return res.status(400).json({ error: "label and a valid utilityType ('water' or 'electricity') are required." });
    }
    if (ratePerUnit == null || Number(ratePerUnit) <= 0) {
      return res.status(400).json({ error: 'ratePerUnit must be a positive number.' });
    }
    if (!Array.isArray(unitIds) || unitIds.length === 0) {
      return res.status(400).json({ error: 'unitIds is required - at least one unit.' });
    }
    if (!isShared && unitIds.length !== 1) {
      return res.status(400).json({ error: 'An individual (non-shared) meter must cover exactly one unit.' });
    }

    const landlordId = await effectiveLandlordId(req);
    const { data: units, error: unitsErr } = await supabase
      .from('units')
      .select('id, landlord_id, property_id')
      .in('id', unitIds);
    if (unitsErr) throw unitsErr;
    const missing = unitIds.filter((id) => !(units || []).some((u) => u.id === id));
    if (missing.length > 0) return res.status(404).json({ error: 'One or more units were not found.' });
    const foreignUnit = (units || []).find((u) => u.landlord_id !== landlordId);
    if (foreignUnit) return res.status(403).json({ error: 'One or more units do not belong to your account.' });

    const { role, id } = currentActor(req);
    const { data: meter, error } = await supabase
      .from('utility_meters')
      .insert({
        landlord_id: landlordId,
        property_id: propertyId || units[0].property_id || null,
        label,
        utility_type: utilityType,
        is_shared: !!isShared,
        rate_per_unit: Number(ratePerUnit),
        created_by_role: role,
        created_by_id: id,
      })
      .select()
      .single();
    if (error) throw error;

    const { error: linkErr } = await supabase
      .from('utility_meter_units')
      .insert(unitIds.map((unitId) => ({ meter_id: meter.id, unit_id: unitId })));
    if (linkErr) throw linkErr;

    logActivity({ actorType: role, actorId: id, action: 'utility_meter_created', targetType: 'utility_meter', targetId: meter.id, metadata: { isShared: !!isShared, utilityType } });

    return res.status(201).json({ meter });
  } catch (err) {
    logger.error('[utilitySubmetering] createMeter error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to create meter.' });
  }
}

async function listMeters(req, res) {
  try {
    const landlordId = await effectiveLandlordId(req);
    const { data, error } = await supabase
      .from('utility_meters')
      .select('*, utility_meter_units(unit_id, units(unit_name))')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ meters: data || [] });
  } catch (err) {
    logger.error('[utilitySubmetering] listMeters error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load meters.' });
  }
}

async function getMeterOr404(meterId) {
  const { data, error } = await supabase.from('utility_meters').select('*').eq('id', meterId).maybeSingle();
  if (error) throw error;
  return data;
}

async function assertMeterAccess(req, meter) {
  if (!meter) return { statusCode: 404, error: 'Meter not found.' };
  const ownershipError = await checkLandlordOwnership(req, meter.landlord_id);
  if (ownershipError) return ownershipError;
  if (meter.property_id) {
    const propertyAccessError = await checkManagerPropertyAccess(req, meter.property_id);
    if (propertyAccessError) return propertyAccessError;
  }
  return null;
}

// ---------------------------------------------------------------------
// SECTION 1 + 2 - submit a reading (or the first-ever baseline).
// ---------------------------------------------------------------------

async function submitReading(req, res) {
  try {
    const { meterId } = req.params;
    const { monthKey, readingValue, photoUrl, isBaseline } = req.body;

    if (!monthKey || !MONTH_KEY_RE.test(monthKey)) {
      return res.status(400).json({ error: 'monthKey is required in YYYY-MM format.' });
    }
    if (readingValue == null || Number.isNaN(Number(readingValue))) {
      return res.status(400).json({ error: 'readingValue is required and must be a number.' });
    }
    // DIRECT REQUEST: photo proof is optional, not mandatory, for any
    // reading (baseline or otherwise). photo_url is simply null if
    // omitted - not blocking here anymore.

    const meter = await getMeterOr404(meterId);
    const accessError = await assertMeterAccess(req, meter);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    // SECTION 1 - duplicate protection: one reading per meter+month, full stop.
    const { data: existing } = await supabase
      .from('utility_readings')
      .select('id')
      .eq('meter_id', meterId)
      .eq('month_key', monthKey)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({ error: `A reading has already been submitted for this meter for ${monthKey}. Use the correction flow if it needs to change.` });
    }

    const { role, id } = currentActor(req);

    // SECTION 2 - if this meter has no history at all, the very first
    // submission is treated as the baseline: no usage/amount computed,
    // it just becomes the reference point for next month.
    const { data: anyPrior } = await supabase.from('utility_readings').select('id').eq('meter_id', meterId).limit(1).maybeSingle();
    const treatAsBaseline = !!isBaseline || !anyPrior;

    if (treatAsBaseline) {
      const { data: reading, error } = await supabase
        .from('utility_readings')
        .insert({
          meter_id: meterId,
          month_key: monthKey,
          reading_value: Number(readingValue),
          photo_url: photoUrl || null,
          is_baseline: true,
          submitted_by_role: role,
          submitted_by_id: id,
          status: 'submitted',
        })
        .select()
        .single();
      if (error) throw error;
      logActivity({ actorType: role, actorId: id, action: 'utility_baseline_set', targetType: 'utility_meter', targetId: meterId, metadata: { monthKey, readingValue } });
      return res.status(201).json({ reading, isBaseline: true, message: 'Baseline reading recorded. Usage will be calculated from next month\'s reading.' });
    }

    // SECTION 3 - a real month-over-month reading: needs a previous
    // reading to calculate against (guaranteed to exist here, since
    // treatAsBaseline above already handled the no-history case).
    const previous = await svc.getPreviousReading(meterId, monthKey);
    if (!previous) {
      return res.status(400).json({ error: 'No baseline/previous reading exists for this meter yet. Submit a baseline reading first.' });
    }

    let usage = null;
    let anomalyFlag = false;
    let anomalyReason = null;

    if (!meter.is_shared) {
      const calc = svc.calculateIndividualUsage(readingValue, previous.reading_value, meter.rate_per_unit);
      usage = calc.usage;
      const anomaly = await svc.detectAnomaly(meterId, usage);
      anomalyFlag = anomaly.anomaly;
      anomalyReason = anomaly.reason;
    } else {
      // SECTION 5 - shared meters: total usage is still new-minus-
      // previous at the meter level; the per-unit split happens later
      // on the review screen (Section 6), not at submission time.
      usage = Number(readingValue) - Number(previous.reading_value);
      const anomaly = await svc.detectAnomaly(meterId, usage);
      anomalyFlag = anomaly.anomaly;
      anomalyReason = anomaly.reason;
    }

    const { data: reading, error } = await supabase
      .from('utility_readings')
      .insert({
        meter_id: meterId,
        month_key: monthKey,
        reading_value: Number(readingValue),
        photo_url: photoUrl,
        is_baseline: false,
        submitted_by_role: role,
        submitted_by_id: id,
        usage_amount: usage,
        anomaly_flag: anomalyFlag,
        anomaly_reason: anomalyReason,
        status: 'submitted',
      })
      .select()
      .single();
    if (error) throw error;

    logActivity({ actorType: role, actorId: id, action: 'utility_reading_submitted', targetType: 'utility_meter', targetId: meterId, metadata: { monthKey, readingValue, usage, anomalyFlag } });

    return res.status(201).json({
      reading,
      isBaseline: false,
      usage,
      anomaly: anomalyFlag ? { flagged: true, reason: anomalyReason } : { flagged: false },
      message: anomalyFlag
        ? 'Reading submitted, but this looks unusual - please double check it on the review screen.'
        : 'Reading submitted. Continue to the review screen to finalize billing.',
    });
  } catch (err) {
    logger.error('[utilitySubmetering] submitReading error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit reading.' });
  }
}

// List a meter's readings (most recent month first) - the history
// view a caretaker/manager/landlord needs to find a past reading to
// correct, or to jump back into an in-progress review.
async function listReadings(req, res) {
  try {
    const { meterId } = req.params;
    const meter = await getMeterOr404(meterId);
    const accessError = await assertMeterAccess(req, meter);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    const { data, error } = await supabase
      .from('utility_readings')
      .select('*')
      .eq('meter_id', meterId)
      .order('month_key', { ascending: false });
    if (error) throw error;
    return res.json({ readings: data || [] });
  } catch (err) {
    logger.error('[utilitySubmetering] listReadings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load readings.' });
  }
}

// ---------------------------------------------------------------------
// SECTION 2 - correct a past reading (baseline included). Mandatory
// reason, fully logged: who/when/reason/old/new.
// ---------------------------------------------------------------------

async function correctReading(req, res) {
  try {
    const { readingId } = req.params;
    const { newValue, reason } = req.body;

    if (newValue == null || Number.isNaN(Number(newValue))) {
      return res.status(400).json({ error: 'newValue is required and must be a number.' });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'A reason is required to correct a reading.' });
    }

    const { data: reading, error: readErr } = await supabase.from('utility_readings').select('*').eq('id', readingId).maybeSingle();
    if (readErr) throw readErr;
    if (!reading) return res.status(404).json({ error: 'Reading not found.' });

    const meter = await getMeterOr404(reading.meter_id);
    const accessError = await assertMeterAccess(req, meter);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    if (reading.status === 'finalized') {
      return res.status(400).json({ error: 'This reading has already been finalized and billed - it can no longer be corrected here. Contact support for a finalized-record correction.' });
    }

    const { role, id } = currentActor(req);
    const oldValue = reading.reading_value;

    // Recompute usage/anomaly if this reading has a "previous" to
    // compare against (baseline corrections have nothing to recompute).
    let usage = reading.usage_amount;
    let anomalyFlag = reading.anomaly_flag;
    let anomalyReason = reading.anomaly_reason;
    if (!reading.is_baseline) {
      const previous = await svc.getPreviousReading(meter.id, reading.month_key);
      if (previous) {
        usage = Number(newValue) - Number(previous.reading_value);
        const anomaly = await svc.detectAnomaly(meter.id, usage);
        anomalyFlag = anomaly.anomaly;
        anomalyReason = anomaly.reason;
      }
    }

    const { data: updated, error: updErr } = await supabase
      .from('utility_readings')
      .update({ reading_value: Number(newValue), usage_amount: usage, anomaly_flag: anomalyFlag, anomaly_reason: anomalyReason })
      .eq('id', readingId)
      .select()
      .single();
    if (updErr) throw updErr;

    const { error: logErr } = await supabase.from('utility_reading_corrections').insert({
      reading_id: readingId,
      changed_by_role: role,
      changed_by_id: id,
      reason: reason.trim(),
      old_value: oldValue,
      new_value: Number(newValue),
    });
    if (logErr) throw logErr;

    logActivity({ actorType: role, actorId: id, action: 'utility_reading_corrected', targetType: 'utility_reading', targetId: readingId, metadata: { oldValue, newValue, reason } });

    return res.json({ reading: updated, message: 'Reading corrected.' });
  } catch (err) {
    logger.error('[utilitySubmetering] correctReading error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to correct reading.' });
  }
}

async function getReadingCorrections(req, res) {
  try {
    const { readingId } = req.params;
    const { data: reading } = await supabase.from('utility_readings').select('meter_id').eq('id', readingId).maybeSingle();
    if (!reading) return res.status(404).json({ error: 'Reading not found.' });
    const meter = await getMeterOr404(reading.meter_id);
    const accessError = await assertMeterAccess(req, meter);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    const { data, error } = await supabase
      .from('utility_reading_corrections')
      .select('*')
      .eq('reading_id', readingId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ corrections: data || [] });
  } catch (err) {
    logger.error('[utilitySubmetering] getReadingCorrections error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load correction history.' });
  }
}

// ---------------------------------------------------------------------
// SECTION 6 - review screen. Builds (or re-fetches) a draft billing
// run for a submitted reading: individual -> one run-unit row; shared
// -> one row per occupied unit from Section 4/5's split.
// ---------------------------------------------------------------------

async function getOrCreateBillingRun(reading, meter) {
  const { data: existingRun } = await supabase.from('utility_billing_runs').select('*, utility_billing_run_units(*, units(unit_name))').eq('reading_id', reading.id).maybeSingle();
  if (existingRun) return existingRun;

  let runUnits;
  let totalUsage;

  if (!meter.is_shared) {
    const { data: meterUnit } = await supabase.from('utility_meter_units').select('unit_id').eq('meter_id', meter.id).limit(1).maybeSingle();
    totalUsage = reading.usage_amount;
    const amount = Math.round(totalUsage * meter.rate_per_unit * 100) / 100;
    runUnits = [{ unitId: meterUnit.unit_id, occupiedDays: svc.daysInMonth(reading.month_key), amount }];
  } else {
    totalUsage = reading.usage_amount;
    const occupied = await svc.getOccupiedUnitsForMonth(meter.id, reading.month_key);
    runUnits = svc.splitSharedUsage(totalUsage, meter.rate_per_unit, occupied);
  }

  const { data: run, error } = await supabase
    .from('utility_billing_runs')
    .insert({ reading_id: reading.id, meter_id: meter.id, month_key: reading.month_key, total_usage: totalUsage, status: 'draft' })
    .select()
    .single();
  if (error) throw error;

  const { error: unitsErr } = await supabase.from('utility_billing_run_units').insert(
    runUnits.map((u) => ({
      run_id: run.id,
      unit_id: u.unitId,
      occupied_days: u.occupiedDays,
      computed_amount: u.amount,
      final_amount: u.amount,
    }))
  );
  if (unitsErr) throw unitsErr;

  await supabase.from('utility_readings').update({ status: 'in_review' }).eq('id', reading.id);

  const { data: full } = await supabase.from('utility_billing_runs').select('*, utility_billing_run_units(*, units(unit_name))').eq('id', run.id).single();
  return full;
}

async function getReview(req, res) {
  try {
    const { readingId } = req.params;
    const { data: reading } = await supabase.from('utility_readings').select('*').eq('id', readingId).maybeSingle();
    if (!reading) return res.status(404).json({ error: 'Reading not found.' });
    if (reading.is_baseline) return res.status(400).json({ error: 'A baseline reading has nothing to review or bill.' });

    const meter = await getMeterOr404(reading.meter_id);
    const accessError = await assertMeterAccess(req, meter);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    const run = await getOrCreateBillingRun(reading, meter);
    return res.json({ reading, meter, run });
  } catch (err) {
    logger.error('[utilitySubmetering] getReview error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load review.' });
  }
}

// SECTION 6 - override a single run-unit's occupied-days or final
// amount. Mandatory reason. Overriding occupied-days recalculates
// every unit in the run live (the divisor changed for everyone).
async function overrideRunUnit(req, res) {
  try {
    const { runId, runUnitId } = req.params;
    const { occupiedDays, finalAmount, reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'A reason is required for any override.' });
    }
    if (occupiedDays == null && finalAmount == null) {
      return res.status(400).json({ error: 'Provide occupiedDays and/or finalAmount to override.' });
    }

    const { data: run, error: runErr } = await supabase.from('utility_billing_runs').select('*, utility_billing_run_units(*, units(unit_name))').eq('id', runId).maybeSingle();
    if (runErr) throw runErr;
    if (!run) return res.status(404).json({ error: 'Billing run not found.' });
    if (run.status === 'finalized') return res.status(400).json({ error: 'This billing run has already been finalized and can no longer be edited here.' });

    const meter = await getMeterOr404(run.meter_id);
    const accessError = await assertMeterAccess(req, meter);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    const targetRow = run.utility_billing_run_units.find((u) => u.id === runUnitId);
    if (!targetRow) return res.status(404).json({ error: 'That unit is not part of this billing run.' });

    // Direct final-amount override: only touches this one row.
    if (finalAmount != null && occupiedDays == null) {
      const { error } = await supabase
        .from('utility_billing_run_units')
        .update({ final_amount: Number(finalAmount), amount_overridden: true, amount_override_reason: reason.trim() })
        .eq('id', runUnitId);
      if (error) throw error;
    } else {
      // Occupied-days override: recalculates every row in the run,
      // since the total occupied-days pool changed (Section 6).
      const updatedRows = run.utility_billing_run_units.map((u) =>
        u.id === runUnitId ? { ...u, occupied_days: Number(occupiedDays) } : u
      );
      const recalced = svc.splitSharedUsage(
        run.total_usage,
        meter.rate_per_unit,
        updatedRows.map((u) => ({ unitId: u.unit_id, occupiedDays: u.occupied_days }))
      );

      for (const row of updatedRows) {
        const newCalc = recalced.find((r) => r.unitId === row.unit_id);
        const isTarget = row.id === runUnitId;
        await supabase
          .from('utility_billing_run_units')
          .update({
            occupied_days: row.occupied_days,
            occupied_days_overridden: isTarget ? true : row.occupied_days_overridden,
            occupied_days_override_reason: isTarget ? reason.trim() : row.occupied_days_override_reason,
            computed_amount: newCalc.amount,
            // A row that was manually amount-overridden keeps its
            // manual amount even as the pool recalculates around it;
            // every other row's final_amount tracks the new computed value.
            final_amount: row.amount_overridden ? row.final_amount : newCalc.amount,
          })
          .eq('id', row.id);
      }
    }

    const { role, id } = currentActor(req);
    logActivity({ actorType: role, actorId: id, action: 'utility_billing_override', targetType: 'utility_billing_run_unit', targetId: runUnitId, metadata: { occupiedDays, finalAmount, reason } });

    const { data: refreshed } = await supabase.from('utility_billing_runs').select('*, utility_billing_run_units(*, units(unit_name))').eq('id', runId).single();
    return res.json({ run: refreshed, message: 'Override applied and totals recalculated.' });
  } catch (err) {
    logger.error('[utilitySubmetering] overrideRunUnit error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to apply override.' });
  }
}

// ---------------------------------------------------------------------
// SECTION 7 - final submission. The ONLY action that actually bills
// tenants: locks in amounts, appends each unit's final_amount to that
// unit's tenant's balance (same one-time-charge mechanism
// unit.controller.applyExtraChargeToUnit already uses elsewhere in the
// app), notifies affected tenants, and sets this reading as the new
// baseline for next month.
// ---------------------------------------------------------------------

async function finalizeRun(req, res) {
  try {
    const { runId } = req.params;
    const { data: run, error: runErr } = await supabase.from('utility_billing_runs').select('*, utility_billing_run_units(*, units(unit_name))').eq('id', runId).maybeSingle();
    if (runErr) throw runErr;
    if (!run) return res.status(404).json({ error: 'Billing run not found.' });
    if (run.status === 'finalized') return res.status(400).json({ error: 'This billing run has already been finalized.' });

    const meter = await getMeterOr404(run.meter_id);
    const accessError = await assertMeterAccess(req, meter);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    const { role, id } = currentActor(req);
    const notifiedUnits = [];

    for (const row of run.utility_billing_run_units) {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('id, full_name, balance_due, phone, primary_phone')
        .eq('unit_id', row.unit_id)
        .eq('is_active', true)
        .maybeSingle();
      if (!tenant) continue; // shouldn't happen (occupied units only reach here), but never fail the whole run over one missing record

      const newBalance = Math.round((Number(tenant.balance_due || 0) + Number(row.final_amount)) * 100) / 100;
      const { error: balErr } = await supabase.from('tenants').update({ balance_due: newBalance }).eq('id', tenant.id);
      if (balErr) throw balErr;

      try {
        await notify('tenant', tenant.id, tenant.primary_phone || tenant.phone, `A ${meter.utility_type} utility charge of KES ${Number(row.final_amount).toLocaleString()} has been added to your upcoming RentaPay invoice.`);
      } catch (notifyErr) {
        logger.error('[utilitySubmetering] finalizeRun: notify failed for tenant', tenant.id, notifyErr.message);
      }
      notifiedUnits.push(row.unit_id);
    }

    await supabase
      .from('utility_billing_runs')
      .update({ status: 'finalized', finalized_at: new Date().toISOString(), finalized_by_role: role, finalized_by_id: id })
      .eq('id', runId);
    await supabase.from('utility_readings').update({ status: 'finalized' }).eq('id', run.reading_id);

    logActivity({ actorType: role, actorId: id, action: 'utility_billing_finalized', targetType: 'utility_billing_run', targetId: runId, metadata: { unitsCharged: notifiedUnits.length } });

    return res.json({ message: `Finalized. ${notifiedUnits.length} tenant${notifiedUnits.length === 1 ? '' : 's'} notified and billed.`, unitsCharged: notifiedUnits.length });
  } catch (err) {
    logger.error('[utilitySubmetering] finalizeRun error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to finalize billing run.' });
  }
}

module.exports = {
  createMeter,
  listMeters,
  submitReading,
  listReadings,
  correctReading,
  getReadingCorrections,
  getReview,
  overrideRunUnit,
  finalizeRun,
};
