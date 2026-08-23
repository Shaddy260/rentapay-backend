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
const { checkLandlordOwnership, checkManagerPropertyAccess, effectiveLandlordId, getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');
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

    // Property-scoping guard: a meter must cover units from exactly
    // one property. Without this, a manager/landlord with multiple
    // properties could accidentally mix units from two different
    // properties into one meter via a stale/incorrect unitIds list.
    const distinctProperties = [...new Set((units || []).map((u) => u.property_id))];
    if (distinctProperties.length > 1) {
      return res.status(400).json({ error: 'All units on a meter must belong to the same property.' });
    }
    if (propertyId && distinctProperties[0] && propertyId !== distinctProperties[0]) {
      return res.status(400).json({ error: 'unitIds do not belong to the given propertyId.' });
    }
    if (req.user.role === 'manager') {
      const propertyAccessError = await checkManagerPropertyAccess(req, propertyId || distinctProperties[0]);
      if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    }

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

// Bulk-create individual (non-shared) meters, one per unit, in a
// single call - for the common case where a landlord has individual
// water/electricity meters for every unit in a property and doesn't
// want to repeat the "Add a meter" form once per unit.
//
// Every meter created this way shares the same utilityType and
// ratePerUnit (the landlord can edit any one of them individually
// afterwards via updateMeter if a specific unit's rate/label needs to
// differ). Labels are auto-generated from each unit's name unless a
// per-unit label override is supplied.
async function bulkCreateMeters(req, res) {
  try {
    const { propertyId, utilityType, ratePerUnit, units } = req.body;
    if (!utilityType || !['water', 'electricity'].includes(utilityType)) {
      return res.status(400).json({ error: "A valid utilityType ('water' or 'electricity') is required." });
    }
    if (ratePerUnit == null || Number(ratePerUnit) <= 0) {
      return res.status(400).json({ error: 'ratePerUnit must be a positive number.' });
    }
    // units: [{ unitId, label? }] - label optional, falls back to
    // "<unit name> - <utility type>".
    if (!Array.isArray(units) || units.length === 0) {
      return res.status(400).json({ error: 'units is required - at least one { unitId } entry.' });
    }

    const landlordId = await effectiveLandlordId(req);
    const unitIds = units.map((u) => u.unitId).filter(Boolean);
    if (unitIds.length !== units.length) {
      return res.status(400).json({ error: 'Every entry in units must include a unitId.' });
    }

    const { data: unitRows, error: unitsErr } = await supabase
      .from('units')
      .select('id, landlord_id, property_id, unit_name')
      .in('id', unitIds);
    if (unitsErr) throw unitsErr;
    const missing = unitIds.filter((id) => !(unitRows || []).some((u) => u.id === id));
    if (missing.length > 0) return res.status(404).json({ error: 'One or more units were not found.' });
    const foreignUnit = (unitRows || []).find((u) => u.landlord_id !== landlordId);
    if (foreignUnit) return res.status(403).json({ error: 'One or more units do not belong to your account.' });

    // Skip units that already have an individual meter of this exact
    // utility type - never silently create a duplicate meter for a
    // unit that's already covered.
    const { data: existingLinks, error: existingErr } = await supabase
      .from('utility_meter_units')
      .select('unit_id, utility_meters!inner(utility_type, is_shared, landlord_id)')
      .in('unit_id', unitIds)
      .eq('utility_meters.utility_type', utilityType)
      .eq('utility_meters.is_shared', false)
      .eq('utility_meters.landlord_id', landlordId);
    if (existingErr) throw existingErr;
    const alreadyCoveredUnitIds = new Set((existingLinks || []).map((l) => l.unit_id));

    const { role, id } = currentActor(req);
    const toCreate = units.filter((u) => !alreadyCoveredUnitIds.has(u.unitId));
    const skipped = units
      .filter((u) => alreadyCoveredUnitIds.has(u.unitId))
      .map((u) => (unitRows.find((row) => row.id === u.unitId) || {}).unit_name || u.unitId);

    const created = [];
    for (const u of toCreate) {
      const unitRow = unitRows.find((row) => row.id === u.unitId);
      const label = (u.label && u.label.trim()) || `${unitRow?.unit_name || 'Unit'} - ${utilityType}`;

      const { data: meter, error } = await supabase
        .from('utility_meters')
        .insert({
          landlord_id: landlordId,
          property_id: propertyId || unitRow?.property_id || null,
          label,
          utility_type: utilityType,
          is_shared: false,
          rate_per_unit: Number(ratePerUnit),
          created_by_role: role,
          created_by_id: id,
        })
        .select()
        .single();
      if (error) throw error;

      const { error: linkErr } = await supabase.from('utility_meter_units').insert({ meter_id: meter.id, unit_id: u.unitId });
      if (linkErr) throw linkErr;

      created.push(meter);
    }

    if (created.length > 0) {
      logActivity({
        actorType: role,
        actorId: id,
        action: 'utility_meters_bulk_created',
        targetType: 'utility_meter',
        metadata: { utilityType, count: created.length, skippedCount: skipped.length },
      });
    }

    return res.status(201).json({
      meters: created,
      createdCount: created.length,
      skipped, // unit names that already had a meter of this type - not touched
    });
  } catch (err) {
    logger.error('[utilitySubmetering] bulkCreateMeters error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to create meters.' });
  }
}

// Edit an existing meter's label, rate, utility type, shared flag, or
// which unit(s) it covers. Every field is optional - only what's
// passed gets changed. Switching is_shared true<->false requires
// unitIds to be supplied too (single-unit lists forced back to
// exactly one unit when un-sharing).
async function updateMeter(req, res) {
  try {
    const { meterId } = req.params;
    const { label, ratePerUnit, utilityType, isShared, unitIds } = req.body;

    const meter = await getMeterOr404(meterId);
    const accessError = await assertMeterAccess(req, meter);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    if (utilityType != null && !['water', 'electricity'].includes(utilityType)) {
      return res.status(400).json({ error: "utilityType must be 'water' or 'electricity'." });
    }
    if (ratePerUnit != null && Number(ratePerUnit) <= 0) {
      return res.status(400).json({ error: 'ratePerUnit must be a positive number.' });
    }

    const nextIsShared = isShared != null ? !!isShared : meter.is_shared;
    if (unitIds != null) {
      if (!Array.isArray(unitIds) || unitIds.length === 0) {
        return res.status(400).json({ error: 'unitIds must be a non-empty array.' });
      }
      if (!nextIsShared && unitIds.length !== 1) {
        return res.status(400).json({ error: 'An individual (non-shared) meter must cover exactly one unit.' });
      }
      const landlordId = await effectiveLandlordId(req);
      const { data: units, error: unitsErr } = await supabase.from('units').select('id, landlord_id').in('id', unitIds);
      if (unitsErr) throw unitsErr;
      const missing = unitIds.filter((uid) => !(units || []).some((u) => u.id === uid));
      if (missing.length > 0) return res.status(404).json({ error: 'One or more units were not found.' });
      const foreignUnit = (units || []).find((u) => u.landlord_id !== landlordId);
      if (foreignUnit) return res.status(403).json({ error: 'One or more units do not belong to your account.' });
    }

    const patch = {};
    if (label != null) patch.label = label;
    if (ratePerUnit != null) patch.rate_per_unit = Number(ratePerUnit);
    if (utilityType != null) patch.utility_type = utilityType;
    if (isShared != null) patch.is_shared = !!isShared;

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('utility_meters').update(patch).eq('id', meterId);
      if (error) throw error;
    }

    if (unitIds != null) {
      const { error: delErr } = await supabase.from('utility_meter_units').delete().eq('meter_id', meterId);
      if (delErr) throw delErr;
      const { error: insErr } = await supabase.from('utility_meter_units').insert(unitIds.map((unitId) => ({ meter_id: meterId, unit_id: unitId })));
      if (insErr) throw insErr;
    }

    const { data: updated, error: fetchErr } = await supabase
      .from('utility_meters')
      .select('*, utility_meter_units(unit_id, units(unit_name))')
      .eq('id', meterId)
      .single();
    if (fetchErr) throw fetchErr;

    const { role, id } = currentActor(req);
    logActivity({ actorType: role, actorId: id, action: 'utility_meter_updated', targetType: 'utility_meter', targetId: meterId, metadata: patch });

    return res.json({ meter: updated });
  } catch (err) {
    logger.error('[utilitySubmetering] updateMeter error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update meter.' });
  }
}

// Permanently remove a meter that has never had any readings
// submitted against it - e.g. cleaning up a duplicate created by
// mistake. Meters with reading history can't be deleted (their
// numbers may already be reflected in past invoices); edit them
// instead.
async function deleteMeter(req, res) {
  try {
    const { meterId } = req.params;
    const meter = await getMeterOr404(meterId);
    const accessError = await assertMeterAccess(req, meter);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    const { data: anyReading } = await supabase.from('utility_readings').select('id').eq('meter_id', meterId).limit(1).maybeSingle();
    if (anyReading) {
      return res.status(409).json({ error: 'This meter already has readings on file and cannot be deleted. Edit it instead if something needs to change.' });
    }

    const { error: linkErr } = await supabase.from('utility_meter_units').delete().eq('meter_id', meterId);
    if (linkErr) throw linkErr;
    const { error } = await supabase.from('utility_meters').delete().eq('id', meterId);
    if (error) throw error;

    const { role, id } = currentActor(req);
    logActivity({ actorType: role, actorId: id, action: 'utility_meter_deleted', targetType: 'utility_meter', targetId: meterId });

    return res.json({ deleted: true });
  } catch (err) {
    logger.error('[utilitySubmetering] deleteMeter error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to delete meter.' });
  }
}

async function listMeters(req, res) {
  try {
    const landlordId = await effectiveLandlordId(req);
    // Managers are scoped to whichever property they're assigned to -
    // never show them a cross-property picker or another property's
    // meters. A landlord with multiple properties must pass
    // ?propertyId= explicitly (each property's dashboard supplies its
    // own id); with none given, a landlord sees everything they own,
    // same as before this change.
    let propertyId = req.query.propertyId || null;
    if (req.user.role === 'manager' && !propertyId) {
      const assignedIds = await getManagerAssignedPropertyIds(req.user.id);
      if (assignedIds && assignedIds.length === 1) propertyId = assignedIds[0];
    }

    let query = supabase
      .from('utility_meters')
      .select('*, utility_meter_units(unit_id, units(unit_name))')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: false });
    if (propertyId) query = query.eq('property_id', propertyId);

    const { data, error } = await query;
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

// Core of Section 1+2+3, factored out so both the single-meter HTTP
// handler (submitReading) and the bulk handler (bulkSubmitReadings)
// share one code path - no duplicated business logic to drift apart.
// Throws { statusCode, error } for anything that should map to a
// non-500 HTTP response; anything else propagates as a real error.
async function submitReadingCore(req, { meterId, monthKey, readingValue, photoUrl, isBaseline, previousReadingValue }) {
  if (!monthKey || !MONTH_KEY_RE.test(monthKey)) {
    throw { statusCode: 400, error: 'monthKey is required in YYYY-MM format.' };
  }
  if (readingValue == null || Number.isNaN(Number(readingValue))) {
    throw { statusCode: 400, error: 'readingValue is required and must be a number.' };
  }

  const meter = await getMeterOr404(meterId);
  const accessError = await assertMeterAccess(req, meter);
  if (accessError) throw { statusCode: accessError.statusCode, error: accessError.error };

  const { data: existing } = await supabase
    .from('utility_readings')
    .select('id')
    .eq('meter_id', meterId)
    .eq('month_key', monthKey)
    .maybeSingle();
  if (existing) {
    throw { statusCode: 409, error: `A reading has already been submitted for this meter for ${monthKey}. Use the correction flow if it needs to change.` };
  }

  const { role, id } = currentActor(req);

  const { data: anyPrior } = await supabase.from('utility_readings').select('id').eq('meter_id', meterId).limit(1).maybeSingle();
  const isFirstEverReading = !anyPrior;

  // First reading ever taken on this meter, and the caller hasn't
  // told us what the meter read before now: don't silently record it
  // as a zero-usage baseline. Ask for the previous reading instead so
  // we can bill usage from day one. The frontend shows this as an
  // inline "what did the meter read before this?" prompt.
  if (isFirstEverReading && !isBaseline && (previousReadingValue == null || previousReadingValue === '')) {
    return {
      statusCode: 200,
      body: {
        needsPreviousReading: true,
        message: 'This meter has no reading on file yet. Enter the previous reading before this one so usage can be billed straight away.',
      },
    };
  }

  // Explicit baseline entry (no prior reading to bill against at all,
  // e.g. a brand-new installation) - record it and wait for next month.
  if (isBaseline) {
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
    await supabase.from('utility_meters').update({ awaiting_previous_reading: false }).eq('id', meterId);
    logActivity({ actorType: role, actorId: id, action: 'utility_baseline_set', targetType: 'utility_meter', targetId: meterId, metadata: { monthKey, readingValue } });
    return { statusCode: 201, body: { reading, isBaseline: true, message: 'Baseline reading recorded. Usage will be calculated from next month\'s reading.' } };
  }

  // First-ever reading WITH a previous reading supplied: file the
  // previous reading as a baseline dated one month earlier, so the
  // usual getPreviousReading() lookup finds it and this month bills
  // normally - no special-cased usage math needed below.
  if (isFirstEverReading && previousReadingValue != null && previousReadingValue !== '') {
    if (Number.isNaN(Number(previousReadingValue))) {
      throw { statusCode: 400, error: 'previousReadingValue must be a number.' };
    }
    const priorMonthKey = svc.decrementMonthKey(monthKey);
    const { error: priorErr } = await supabase
      .from('utility_readings')
      .insert({
        meter_id: meterId,
        month_key: priorMonthKey,
        reading_value: Number(previousReadingValue),
        is_baseline: true,
        submitted_by_role: role,
        submitted_by_id: id,
        status: 'submitted',
      });
    if (priorErr) throw priorErr;
    await supabase.from('utility_meters').update({ awaiting_previous_reading: false }).eq('id', meterId);
  }

  const previous = await svc.getPreviousReading(meterId, monthKey);
  if (!previous) {
    throw { statusCode: 400, error: 'No baseline/previous reading exists for this meter yet. Submit a baseline reading first.' };
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

  return {
    statusCode: 201,
    body: {
      reading,
      isBaseline: false,
      usage,
      anomaly: anomalyFlag ? { flagged: true, reason: anomalyReason } : { flagged: false },
      message: anomalyFlag
        ? 'Reading submitted, but this looks unusual - please double check it on the review screen.'
        : 'Reading submitted. Continue to the review screen to finalize billing.',
    },
  };
}

async function submitReading(req, res) {
  try {
    const { meterId } = req.params;
    const { monthKey, readingValue, photoUrl, isBaseline, previousReadingValue } = req.body;
    const result = await submitReadingCore(req, { meterId, monthKey, readingValue, photoUrl, isBaseline, previousReadingValue });
    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    if (err && err.statusCode) return res.status(err.statusCode).json({ error: err.error });
    logger.error('[utilitySubmetering] submitReading error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit reading.' });
  }
}

// Submit readings for several meters at once (e.g. a caretaker
// walking the whole property and entering every unit's reading in one
// screen). Each entry is processed independently through the exact
// same core logic as the single-meter endpoint, so per-meter baseline
// detection, duplicate protection, and anomaly detection all behave
// identically - a failure on one meter (e.g. a duplicate for that
// month) never blocks or rolls back the others.
async function bulkSubmitReadings(req, res) {
  try {
    const { monthKey, readings } = req.body;
    if (!monthKey || !MONTH_KEY_RE.test(monthKey)) {
      return res.status(400).json({ error: 'monthKey is required in YYYY-MM format.' });
    }
    if (!Array.isArray(readings) || readings.length === 0) {
      return res.status(400).json({ error: 'readings is required - at least one { meterId, readingValue } entry.' });
    }

    const results = [];
    for (const entry of readings) {
      const { meterId, readingValue, photoUrl, isBaseline, previousReadingValue } = entry;
      if (!meterId) {
        results.push({ meterId: null, ok: false, error: 'Missing meterId.' });
        continue;
      }
      try {
        const result = await submitReadingCore(req, { meterId, monthKey, readingValue, photoUrl, isBaseline, previousReadingValue });
        results.push({ meterId, ok: true, ...result.body });
      } catch (err) {
        if (err && err.statusCode) {
          results.push({ meterId, ok: false, error: err.error });
        } else {
          logger.error(`[utilitySubmetering] bulkSubmitReadings meter ${meterId} error:`, err.message);
          captureException(err);
          results.push({ meterId, ok: false, error: 'Failed to submit this reading.' });
        }
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    return res.status(207).json({
      results,
      succeeded,
      failed: results.length - succeeded,
    });
  } catch (err) {
    logger.error('[utilitySubmetering] bulkSubmitReadings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit readings.' });
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
    const { data: meterUnit } = await supabase.from('utility_meter_units').select('unit_id, units(unit_name)').eq('meter_id', meter.id).limit(1).maybeSingle();
    if (!meterUnit) {
      throw Object.assign(new Error('This meter is not linked to any unit. Edit the meter and select the unit it belongs to.'), { statusCode: 400 });
    }
    // THE FIX (direct request): "meter invoices should send to active
    // occupied units... nothing is sent even after submitting." Root
    // cause - this branch built a billing row for whatever unit the
    // meter was linked to, with NO check that unit actually has an
    // active tenant right now. A vacant unit's linked meter would
    // silently sail through review, get finalized, and only THEN
    // fail at the tenant lookup in finalizeRun - by which point the
    // run was already marked "finalized" with "0 tenants notified"
    // and no way to tell why. Checking occupancy here, before a run
    // even gets created, turns that into an immediate, actionable
    // error instead of a silent no-op three screens later.
    const { data: activeTenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('unit_id', meterUnit.unit_id)
      .eq('is_active', true)
      .maybeSingle();
    if (!activeTenant) {
      throw Object.assign(
        new Error(`${meterUnit.units?.unit_name || 'This unit'} has no active tenant right now, so there's nobody to bill. Assign a tenant to the unit first, or check the meter is linked to the right unit.`),
        { statusCode: 400 }
      );
    }
    totalUsage = reading.usage_amount;
    const amount = Math.round(totalUsage * meter.rate_per_unit * 100) / 100;
    runUnits = [{ unitId: meterUnit.unit_id, occupiedDays: svc.daysInMonth(reading.month_key), amount }];
  } else {
    totalUsage = reading.usage_amount;
    const occupied = await svc.getOccupiedUnitsForMonth(meter.id, reading.month_key);
    // Same fix, shared-meter side: if every unit this meter covers is
    // currently vacant, splitSharedUsage([]) would otherwise return
    // an empty list and finalize would again "succeed" with nothing
    // billed. Fail loudly here instead, before a draft run is created.
    if (!occupied || occupied.length === 0) {
      throw Object.assign(
        new Error('None of the units on this meter currently have an active tenant, so there\u2019s nobody to bill this reading to.'),
        { statusCode: 400 }
      );
    }
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
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
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
    const skippedUnits = [];

    for (const row of run.utility_billing_run_units) {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('id, full_name, balance_due, phone, primary_phone')
        .eq('unit_id', row.unit_id)
        .eq('is_active', true)
        .maybeSingle();
      if (!tenant) {
        // Can still happen even after the review-time check added
        // above, if the tenant moved out in the gap between opening
        // review and clicking Finalize - rare, but silently
        // discarding the charge would mean it's gone for good. Skip
        // this one unit, keep going for the rest, and report it by
        // name at the end instead of a bare "0 tenants" with no clue
        // why.
        skippedUnits.push(row.units?.unit_name || row.unit_id);
        continue;
      }

      // Phase 2: utility charges are billed as their own invoice only
      // - they no longer touch tenants.balance_due, which is rent-only
      // from this point forward. This is the change that makes "pay
      // water" and "pay rent" independent in the tenant portal.
      // Real, queryable invoice - not just an SMS - so the tenant
      // portal can render it under the payment banner and let the
      // tenant pay it as its own line item (separate from rent).
      const { error: invoiceErr } = await supabase.from('utility_invoices').insert({
        tenant_id: tenant.id,
        unit_id: row.unit_id,
        landlord_id: meter.landlord_id,
        meter_id: meter.id,
        run_id: run.id,
        run_unit_id: row.id,
        utility_type: meter.utility_type,
        month_key: run.month_key,
        usage_amount: meter.is_shared ? null : run.total_usage,
        rate_per_unit: meter.rate_per_unit,
        amount: row.final_amount,
        status: 'unpaid',
      });
      if (invoiceErr) throw invoiceErr;

      try {
        await notify('tenant', tenant.id, tenant.primary_phone || tenant.phone, `Your ${meter.utility_type} bill for ${run.month_key} is KES ${Number(row.final_amount).toLocaleString()}. It's been added to your RentaPay account as a separate invoice from rent - open the app to view and pay it.`);
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

    logActivity({ actorType: role, actorId: id, action: 'utility_billing_finalized', targetType: 'utility_billing_run', targetId: runId, metadata: { unitsCharged: notifiedUnits.length, skippedUnits } });

    const skippedNote = skippedUnits.length > 0
      ? ` ${skippedUnits.length} unit${skippedUnits.length === 1 ? '' : 's'} skipped (no active tenant): ${skippedUnits.join(', ')}.`
      : '';
    return res.json({
      message: `Finalized. ${notifiedUnits.length} tenant${notifiedUnits.length === 1 ? '' : 's'} notified and billed.${skippedNote}`,
      unitsCharged: notifiedUnits.length,
      skippedUnits,
    });
  } catch (err) {
    logger.error('[utilitySubmetering] finalizeRun error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to finalize billing run.' });
  }
}

module.exports = {
  createMeter,
  bulkCreateMeters,
  updateMeter,
  deleteMeter,
  listMeters,
  submitReading,
  bulkSubmitReadings,
  listReadings,
  correctReading,
  getReadingCorrections,
  getReview,
  overrideRunUnit,
  finalizeRun,
};
