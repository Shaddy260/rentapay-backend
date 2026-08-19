// src/controllers/unit.controller.js
const { effectiveLandlordId, getManagerAssignedPropertyIds, checkLandlordOwnership, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
//
// Implements blueprint section 7 (Unit Management) and the Step 3/4
// of the Setup Wizard (3.2): creating units, extra charges, status
// transitions, and the actions listed in 7.3.

const supabase = require('../config/supabase');
const { generateUnitCode, regenerateUnitCode, escapeLikePattern } = require('../utils/unitCode');
const { logActivity } = require('../services/activityLog.service');
const { blockIfSubscriptionExpired } = require('../utils/subscriptionGate');
const { notify } = require('../services/notify.service');
const templates = require('../services/notificationTemplates');
const { postSystemAnnouncement } = require('./announcement.controller');
const { validatePositiveAmount } = require('../utils/validateAmount');
const { reconcileLandlordUnitLimits } = require('../utils/unitLimitEnforcement');
const { notifyVacancyAlertSubscribers } = require('../services/vacancyAlertPush.service');
const { captureException } = require('../services/sentry.service');
const { runInBatches } = require('../utils/concurrency');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------
// CREATE UNIT (Setup Wizard step 3/4, or "Add new units" anytime - 7.3)
// ---------------------------------------------------------------------
async function createUnit(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { unitName, unitType, rentAmount, dueDayOfMonth, extraCharges, propertyId, requiresDeposit, depositAmountExpected } = req.body;

    if (!unitName || !rentAmount) {
      return res.status(400).json({ error: 'unitName and rentAmount are required.' });
    }
    // HARDENING (2B): reject negative/non-numeric rent instead of
    // only checking truthiness (a negative or "abc" rentAmount used
    // to sail through to the database).
    const validatedRent = validatePositiveAmount(rentAmount);
    if (validatedRent === null) {
      return res.status(400).json({ error: 'rentAmount must be a valid positive number.' });
    }
    if (await blockIfSubscriptionExpired(req, res, landlordId, propertyId || null)) return;

    // Self-heal frozen/unfrozen state first (in case unit_limit was
    // edited directly in Supabase - see reconcileLandlordUnitLimits),
    // then actually enforce it - "Add unit" used to insert
    // unconditionally with no check against the subscribed unit_limit
    // at all, letting a landlord add units past what they're paying
    // for.
    await reconcileLandlordUnitLimits(landlordId);

    let scopeIsProperty = false;
    let effectiveLimit = null;
    if (propertyId) {
      const { data: property } = await supabase.from('properties').select('unit_limit').eq('id', propertyId).maybeSingle();
      if (property?.unit_limit != null) {
        effectiveLimit = property.unit_limit;
        scopeIsProperty = true;
      }
    }
    if (effectiveLimit == null) {
      const { data: landlord } = await supabase.from('landlords').select('unit_limit').eq('id', landlordId).maybeSingle();
      effectiveLimit = landlord?.unit_limit ?? null;
    }

    if (effectiveLimit != null) {
      let activeCountQuery = supabase.from('units').select('id', { count: 'exact', head: true }).eq('is_frozen', false);
      activeCountQuery = scopeIsProperty
        ? activeCountQuery.eq('property_id', propertyId)
        : activeCountQuery.eq('landlord_id', landlordId);
      const { count: activeCount, error: countErr } = await activeCountQuery;
      if (countErr) throw countErr;
      if ((activeCount || 0) >= effectiveLimit) {
        return res.status(403).json({
          error: `You've reached your subscribed unit limit (${effectiveLimit}). Upgrade your subscription to add more units.`,
          unitLimitReached: true,
        });
      }
    }

    // "When naming units and the next unit has the same name, give an
    // error - unit name exists." Case-insensitive, trimmed compare,
    // scoped per landlord (two different landlords can both have a
    // "Unit A1" - that's fine).
    const trimmedUnitName = unitName.trim();
    const { data: existingUnit } = await supabase
      .from('units')
      .select('id')
      .eq('landlord_id', landlordId)
      .ilike('unit_name', escapeLikePattern(trimmedUnitName))
      .maybeSingle();
    if (existingUnit) {
      return res.status(409).json({ error: `A unit named "${trimmedUnitName}" already exists.` });
    }

    // HARDENING (huge signup bug: two or more "Add unit" requests for
    // the same landlord landing at the database at nearly the same
    // instant - the setup wizard used to fire them all in parallel via
    // Promise.all, and even sequential callers can still overlap under
    // real network conditions). generateUnitCode's own "does this
    // candidate already exist" check, and the unit_name existence
    // check above, both read-then-decide against data that a
    // sibling request in flight hasn't committed yet, so two requests
    // can compute the SAME "next" code and only one insert can
    // win the database's unique constraint on unit_payment_code - the
    // loser used to bubble up as a bare 500 "Failed to create unit",
    // which reads exactly like nothing was saved even on requests
    // where every other field was perfectly valid. Retrying with a
    // freshly regenerated code (which re-reads the now-committed
    // sibling row) resolves the false failure automatically instead
    // of surfacing a confusing error for what is really just a timing
    // collision, not an actual duplicate.
    let unit = null;
    let insertError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const unitCode = await generateUnitCode(landlordId, trimmedUnitName);
      const { data, error } = await supabase
        .from('units')
        .insert({
          landlord_id: landlordId,
          property_id: propertyId || null,
          unit_name: trimmedUnitName,
          unit_payment_code: unitCode,
          unit_type: unitType || null,
          rent_amount: validatedRent,
          due_day_of_month: dueDayOfMonth || 1,
          extra_charges: extraCharges || [],
          status: 'vacant',
          // DIRECT REQUEST: set at creation time, not only editable
          // afterward - whether this unit requires a deposit from a
          // future tenant, shown on the public vacant-unit listing.
          requires_deposit: !!requiresDeposit,
          deposit_amount_expected: requiresDeposit ? (depositAmountExpected ?? null) : null,
        })
        .select()
        .single();

      if (!error) {
        unit = data;
        insertError = null;
        break;
      }
      insertError = error;
      // Postgres unique-violation code. Only worth retrying for that -
      // any other error (bad column, connection issue, etc) should
      // fail immediately rather than retry blindly.
      if (error.code !== '23505') break;
    }
    if (insertError) throw insertError;

    logActivity({ actorType: 'landlord', actorId: landlordId, action: 'unit_created', targetType: 'unit', targetId: unit.id });

    return res.status(201).json({ unit });
  } catch (err) {
    logger.error('[unit] createUnit error:', err.message);
    captureException(err);
    // Give a real, actionable message for the one case that's most
    // confusing to hit as a generic 500: a genuine unique-constraint
    // collision that survived the retries above (extremely rare, but
    // possible under very heavy concurrent load). Callers - the setup
    // wizard and AddUnit page in particular - already know to show
    // "already exists" as a duplicate rather than a lost save, same as
    // the up-front name check above.
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'A unit with a matching name or payment code already exists. Refresh your units list and try again.' });
    }
    return res.status(500).json({ error: 'Failed to create unit.' });
  }
}

// ---------------------------------------------------------------------
// BULK CREATE UNITS (Setup Wizard "Duplicate" - direct request: unit
// duplication during setup "takes soo long" and should "only take a
// few seconds", not silently fail like before).
//
// createUnit() above is correct but expensive PER UNIT: it re-reads
// the subscription/limit state, re-scans the whole units table for
// the next payment-code number (generateUnitCode), and re-checks the
// name-uniqueness query - every single time. Calling it once per
// duplicated unit (what the wizard used to do, sequentially, to avoid
// the race condition documented on doHandleUnitsSubmit) is correct
// but turns "add 20 units" into 20 full round trips, each repeating
// the same table scans - that's the slowness being reported.
//
// This endpoint does the same checks, but ONCE for the whole batch:
// one subscription check, one limit check, one query for existing
// unit names, one query for the highest payment-code number in use -
// then generates every unit's code locally in memory (nothing else
// can interleave inside a single request) and inserts every unit in
// one batch insert. Units whose name collides with an existing unit
// (or with another unit earlier in the SAME batch) are reported back
// individually instead of failing the whole request, so "add 20
// units" can never again come back as "failed to add units" for the
// 19 that were perfectly fine.
// ---------------------------------------------------------------------
async function bulkCreateUnits(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { units: unitsInput, propertyId, dueDayOfMonth, requiresDeposit, depositAmountExpected } = req.body;

    if (!Array.isArray(unitsInput) || unitsInput.length === 0) {
      return res.status(400).json({ error: 'units must be a non-empty array.' });
    }
    if (unitsInput.length > 200) {
      return res.status(400).json({ error: 'Add up to 200 units per batch.' });
    }

    // Validate every row up front - same rules as createUnit - before
    // touching the database at all, so a single bad row doesn't waste
    // work on the rest.
    const normalized = [];
    for (const raw of unitsInput) {
      const { unitName, unitType, rentAmount } = raw || {};
      if (!unitName || !rentAmount) {
        return res.status(400).json({ error: 'Every unit needs a unitName and rentAmount.' });
      }
      const validatedRent = validatePositiveAmount(rentAmount);
      if (validatedRent === null) {
        return res.status(400).json({ error: `rentAmount for "${unitName}" must be a valid positive number.` });
      }
      normalized.push({ unitName: String(unitName).trim(), unitType: unitType || null, rentAmount: validatedRent });
    }

    if (await blockIfSubscriptionExpired(req, res, landlordId, propertyId || null)) return;
    await reconcileLandlordUnitLimits(landlordId);

    let scopeIsProperty = false;
    let effectiveLimit = null;
    if (propertyId) {
      const { data: property } = await supabase.from('properties').select('unit_limit').eq('id', propertyId).maybeSingle();
      if (property?.unit_limit != null) {
        effectiveLimit = property.unit_limit;
        scopeIsProperty = true;
      }
    }
    if (effectiveLimit == null) {
      const { data: landlord } = await supabase.from('landlords').select('unit_limit').eq('id', landlordId).maybeSingle();
      effectiveLimit = landlord?.unit_limit ?? null;
    }

    if (effectiveLimit != null) {
      let activeCountQuery = supabase.from('units').select('id', { count: 'exact', head: true }).eq('is_frozen', false);
      activeCountQuery = scopeIsProperty
        ? activeCountQuery.eq('property_id', propertyId)
        : activeCountQuery.eq('landlord_id', landlordId);
      const { count: activeCount, error: countErr } = await activeCountQuery;
      if (countErr) throw countErr;
      if ((activeCount || 0) + normalized.length > effectiveLimit) {
        const slotsLeft = Math.max(0, effectiveLimit - (activeCount || 0));
        return res.status(403).json({
          error: `That would add ${normalized.length} units, but your subscription only has ${slotsLeft} slot${slotsLeft === 1 ? '' : 's'} left (limit ${effectiveLimit}).`,
          unitLimitReached: true,
        });
      }
    }

    // One query for every existing unit name (case-insensitive
    // compare, same as createUnit), instead of one query per unit.
    const { data: existingRows, error: existingErr } = await supabase
      .from('units')
      .select('unit_name, unit_payment_code')
      .eq('landlord_id', landlordId);
    if (existingErr) throw existingErr;

    const existingNames = new Set((existingRows || []).map((r) => (r.unit_name || '').toLowerCase()));
    let maxCodeNumber = 0;
    for (const row of existingRows || []) {
      const match = /-(\d{3,})$/.exec(row.unit_payment_code || '');
      if (match) maxCodeNumber = Math.max(maxCodeNumber, parseInt(match[1], 10));
    }

    const toInsert = [];
    const skipped = [];
    const seenInBatch = new Set();
    for (const u of normalized) {
      const key = u.unitName.toLowerCase();
      if (existingNames.has(key) || seenInBatch.has(key)) {
        skipped.push({ unitName: u.unitName, reason: 'A unit with this name already exists.' });
        continue;
      }
      seenInBatch.add(key);
      maxCodeNumber += 1;
      const cleanUnitName = u.unitName.replace(/\s+/g, '').toUpperCase();
      toInsert.push({
        landlord_id: landlordId,
        property_id: propertyId || null,
        unit_name: u.unitName,
        unit_payment_code: `RPA-${cleanUnitName}-${String(maxCodeNumber).padStart(3, '0')}`,
        unit_type: u.unitType,
        rent_amount: u.rentAmount,
        // FEATURE (direct request: "duplicate should be as fast as
        // during signup"): AddUnit.jsx's Duplicate form collects ONE
        // due-day and ONE deposit setting for the whole batch (not
        // per-unit), so applied uniformly here - same as it would be
        // if each unit were created individually via createUnit.
        // Defaults match createUnit's own defaults when not sent at
        // all, so this stays a no-op for the setup wizard's existing
        // calls (which never send these).
        due_day_of_month: dueDayOfMonth || 1,
        requires_deposit: !!requiresDeposit,
        deposit_amount_expected: requiresDeposit ? (depositAmountExpected ?? null) : null,
        extra_charges: [],
        status: 'vacant',
      });
    }

    let inserted = [];
    if (toInsert.length > 0) {
      const { data, error } = await supabase.from('units').insert(toInsert).select();
      if (error) {
        logger.error('[unit] bulkCreateUnits insert error:', error.message);
        captureException(error);
        return res.status(500).json({ error: 'Failed to save units. None were added - try again.' });
      }
      inserted = data || [];
    }

    // Activity log doesn't need to block the response - the units are
    // already saved, so let the person move on to the next wizard step
    // immediately.
    for (const unit of inserted) {
      logActivity({ actorType: 'landlord', actorId: landlordId, action: 'unit_created', targetType: 'unit', targetId: unit.id });
    }

    return res.status(201).json({ units: inserted, skipped });
  } catch (err) {
    logger.error('[unit] bulkCreateUnits error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to create units.' });
  }
}

// ---------------------------------------------------------------------
// LIST UNITS for a landlord (dashboard cards - blueprint 7.2)
// ---------------------------------------------------------------------
async function listUnits(req, res) {
  try {
    const landlordId = req.params.landlordId || effectiveLandlordId(req);
    const { propertyId } = req.query;
    const isManager = req.user.role === 'manager';

    // FIX: a manager/caretaker must only ever see units belonging to
    // properties they're assigned to - see dashboard.controller.js for
    // the fuller explanation of the single-property-access bug this
    // closes. An explicit propertyId they're not assigned to is
    // rejected outright rather than silently returning someone else's
    // units.
    let assignedPropertyIds = null;
    if (isManager) {
      assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (propertyId && propertyId !== 'unassigned' && !assignedPropertyIds.includes(propertyId)) {
        return res.status(403).json({ error: 'You have not been given access to this property.', notAssigned: true });
      }
    }

    // Same non-blocking reconciliation as getLandlordDashboard - see
    // the comment there for why this doesn't block the response.
    reconcileLandlordUnitLimits(landlordId).catch(() => {});

    let query = supabase.from('units').select('*').eq('landlord_id', landlordId).order('unit_name');
    // propertyId === 'unassigned' is a special filter value the property
    // switcher uses for units not grouped under any Property row.
    if (propertyId === 'unassigned') query = query.is('property_id', null);
    else if (propertyId) query = query.eq('property_id', propertyId);
    else if (isManager) {
      query = assignedPropertyIds.length
        ? query.in('property_id', assignedPropertyIds)
        : query.eq('id', '00000000-0000-0000-0000-000000000000');
    }

    const { data: units, error } = await query;

    if (error) throw error;

    // Tenants queried separately rather than via a PostgREST embedded
    // join with a guessed foreign-key constraint name (see getUnit's
    // comment above for the full explanation - that exact pattern was
    // confirmed broken there, so it's removed here too rather than
    // relying on it happening to still work for this query shape).
    const unitIds = (units || []).map((u) => u.id);
    let tenantsByUnit = {};
    if (unitIds.length > 0) {
      const { data: tenants } = await supabase
        .from('tenants')
        .select(
          'id, unit_id, full_name, is_active, balance_due, photo_url, primary_phone, secondary_phone, email, ' +
            'emergency_contact_name, emergency_contact_phone'
        )
        .in('unit_id', unitIds);
      for (const t of tenants || []) {
        if (!tenantsByUnit[t.unit_id]) tenantsByUnit[t.unit_id] = [];
        tenantsByUnit[t.unit_id].push(t);
      }
    }

    const unitsWithTenants = (units || []).map((u) => ({
      ...u,
      tenants: tenantsByUnit[u.id] || [],
    }));

    return res.json({ units: unitsWithTenants });
  } catch (err) {
    logger.error('[unit] listUnits error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch units.' });
  }
}

// ---------------------------------------------------------------------
// UPDATE RENT (blueprint 7.3: "takes effect immediately, next month, or
// on a specific date - tenant notified")
//
// Real scheduling, not just wording: every change is recorded as a row
// in rent_changes (status 'pending' or 'applied'). "Immediately" applies
// to units.rent_amount right now. "Next month" or a custom future date
// is stored as pending and left untouched until its effective_date
// arrives - applyScheduledRentChanges() (run daily by the monthly
// billing cron, see jobs/monthlyBilling.job.js) is what actually flips
// it over, so a landlord can schedule a change today that only takes
// effect weeks later without the amount jumping early.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Shared core of a rent change - extracted so both the single-unit
// endpoint (updateRent, below) and the new bulk endpoint (direct
// request: "bulk actions are largely absent - a landlord with many
// units raising rent 10% across the board currently has to repeat the
// same action once per unit") apply the exact same notification/
// announcement/activity-log behavior instead of drifting apart.
// ---------------------------------------------------------------------
async function applyRentChangeToUnit(unit, { newRentAmount, resolvedDate, isImmediate, actorRole, actorId, landlordId }) {
  const oldAmount = Number(unit.rent_amount || 0);

  const { data: rentChange, error: insertError } = await supabase
    .from('rent_changes')
    .insert({
      unit_id: unit.id,
      landlord_id: landlordId,
      old_amount: oldAmount,
      new_amount: Number(newRentAmount),
      effective_date: resolvedDate.toISOString().slice(0, 10),
      status: isImmediate ? 'applied' : 'pending',
      created_by_type: actorRole === 'manager' ? 'manager' : 'landlord',
      created_by_id: actorId,
      applied_at: isImmediate ? new Date().toISOString() : null,
    })
    .select()
    .single();
  if (insertError) throw insertError;

  if (isImmediate) {
    const { error: updateError } = await supabase.from('units').update({ rent_amount: Number(newRentAmount) }).eq('id', unit.id);
    if (updateError) throw updateError;
  }

  const { data: tenant } = await supabase.from('tenants').select('*').eq('unit_id', unit.id).eq('is_active', true).maybeSingle();
  if (tenant) {
    const effectiveWording = isImmediate ? 'immediately' : `from ${resolvedDate.toLocaleDateString('en-GB')}`;
    const msg = templates.rentAltered(tenant.full_name, newRentAmount, effectiveWording);
    await notify('tenant', tenant.id, tenant.primary_phone, msg, { category: 'account', title: 'Rent Change' });
  }

  const rentAnnounceWording = isImmediate
    ? `Rent for Unit ${unit.unit_name} has been updated to KES ${Number(newRentAmount).toLocaleString()}, effective immediately.`
    : `Rent for Unit ${unit.unit_name} will change to KES ${Number(newRentAmount).toLocaleString()}, effective ${resolvedDate.toLocaleDateString('en-GB')}.`;
  await postSystemAnnouncement(landlordId, rentAnnounceWording, { unitId: unit.id, propertyId: unit.property_id || null });

  logActivity({
    actorType: actorRole,
    actorId: landlordId,
    action: isImmediate ? 'rent_updated' : 'rent_change_scheduled',
    targetType: 'unit',
    targetId: unit.id,
    metadata: { newRentAmount, effectiveDate: rentChange.effective_date, status: rentChange.status },
  });

  return { rentChange, tenantNotified: !!tenant };
}

async function updateRent(req, res) {
  try {
    const { unitId } = req.params;
    const { newRentAmount, effectiveOption, effectiveDate } = req.body;
    const landlordId = effectiveLandlordId(req);

    const validatedNewRent = validatePositiveAmount(newRentAmount);
    if (validatedNewRent === null) {
      return res.status(400).json({ error: 'A valid new rent amount is required.' });
    }
    const option = effectiveOption || 'immediately'; // 'immediately' | 'next_month' | 'custom'
    if (!['immediately', 'next_month', 'custom'].includes(option)) {
      return res.status(400).json({ error: "effectiveOption must be 'immediately', 'next_month', or 'custom'." });
    }
    if (option === 'custom' && !effectiveDate) {
      return res.status(400).json({ error: 'effectiveDate is required when effectiveOption is "custom".' });
    }

    const { data: unit, error: fetchError } = await supabase.from('units').select('*').eq('id', unitId).single();
    if (fetchError || !unit) return res.status(404).json({ error: 'Unit not found.' });
    if (unit.landlord_id !== landlordId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not own this unit.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, unit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    if (unit.is_frozen) {
      return res.status(400).json({ error: 'This unit is frozen because your current subscription covers fewer units than you have. Renew or upgrade your subscription to unlock it.' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let resolvedDate;
    if (option === 'immediately') {
      resolvedDate = today;
    } else if (option === 'next_month') {
      resolvedDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    } else {
      resolvedDate = new Date(effectiveDate);
      resolvedDate.setHours(0, 0, 0, 0);
      if (Number.isNaN(resolvedDate.getTime())) {
        return res.status(400).json({ error: 'effectiveDate is not a valid date.' });
      }
      if (resolvedDate < today) {
        return res.status(400).json({ error: 'effectiveDate cannot be in the past.' });
      }
    }

    const isImmediate = resolvedDate.getTime() <= today.getTime();

    const { rentChange, tenantNotified } = await applyRentChangeToUnit(unit, {
      newRentAmount: validatedNewRent,
      resolvedDate,
      isImmediate,
      actorRole: req.user.role,
      actorId: req.user.id,
      landlordId,
    });

    return res.json({
      message: isImmediate
        ? 'Rent updated immediately.'
        : `Rent change scheduled - takes effect on ${resolvedDate.toLocaleDateString('en-GB')}.`,
      rentChange,
      tenantNotified,
    });
  } catch (err) {
    logger.error('[unit] updateRent error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update rent.' });
  }
}

// ---------------------------------------------------------------------
// BULK RENT CHANGE (direct request: "bulk actions are largely absent
// - a landlord with many units raising rent 10% across the board
// currently has to repeat the same action once per unit"). Applies a
// percentage increase OR a flat new amount across every unit in a
// property (or every unit the caller owns/manages, if no property is
// given) in one request, reusing the exact same per-unit logic as the
// single-unit endpoint above - same notifications, same announcement,
// same activity log, same scheduling rules - just looped.
// ---------------------------------------------------------------------
async function bulkUpdateRent(req, res) {
  try {
    const { propertyId, unitIds, percentIncrease, flatNewAmount, effectiveOption, effectiveDate } = req.body;
    const landlordId = effectiveLandlordId(req);
    const scopedUnitIds = Array.isArray(unitIds) && unitIds.length > 0 ? unitIds : null;

    if (percentIncrease == null && flatNewAmount == null) {
      return res.status(400).json({ error: 'Provide either percentIncrease or flatNewAmount.' });
    }
    if (percentIncrease != null && (Number.isNaN(Number(percentIncrease)) || Number(percentIncrease) === 0)) {
      return res.status(400).json({ error: 'percentIncrease must be a non-zero number (e.g. 10 for +10%, -5 for -5%).' });
    }
    if (flatNewAmount != null) {
      const validated = validatePositiveAmount(flatNewAmount);
      if (validated === null) return res.status(400).json({ error: 'flatNewAmount must be a valid positive number.' });
    }
    const option = effectiveOption || 'immediately';
    if (!['immediately', 'next_month', 'custom'].includes(option)) {
      return res.status(400).json({ error: "effectiveOption must be 'immediately', 'next_month', or 'custom'." });
    }
    if (option === 'custom' && !effectiveDate) {
      return res.status(400).json({ error: 'effectiveDate is required when effectiveOption is "custom".' });
    }

    const isManager = req.user.role === 'manager';
    const assignedPropertyIds = isManager ? await getManagerAssignedPropertyIds(req.user.id) : [];
    if (propertyId && isManager && !assignedPropertyIds.includes(propertyId)) {
      return res.status(403).json({ error: 'You do not manage this property.' });
    }

    let unitsQuery = supabase.from('units').select('*').eq('landlord_id', landlordId).eq('is_frozen', false);
    if (scopedUnitIds) {
      unitsQuery = unitsQuery.in('id', scopedUnitIds);
    } else if (propertyId) {
      unitsQuery = unitsQuery.eq('property_id', propertyId);
    } else if (isManager) {
      if (assignedPropertyIds.length === 0) return res.json({ message: 'No units to update.', updated: 0, skipped: 0 });
      unitsQuery = unitsQuery.in('property_id', assignedPropertyIds);
    }
    const { data: units, error: unitsErr } = await unitsQuery;
    if (unitsErr) throw unitsErr;
    if (!units || units.length === 0) {
      return res.json({ message: 'No units to update.', updated: 0, skipped: 0 });
    }
    // When specific units were requested, make sure a manager can't
    // sneak in units outside their assigned properties by passing IDs
    // directly (propertyId-based scoping already checked above, but
    // unitIds bypasses that path).
    if (scopedUnitIds && isManager) {
      const disallowed = units.some((u) => !assignedPropertyIds.includes(u.property_id));
      if (disallowed) return res.status(403).json({ error: 'You do not manage one or more of the selected units.' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let resolvedDate;
    if (option === 'immediately') resolvedDate = today;
    else if (option === 'next_month') resolvedDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    else {
      resolvedDate = new Date(effectiveDate);
      resolvedDate.setHours(0, 0, 0, 0);
      if (Number.isNaN(resolvedDate.getTime())) return res.status(400).json({ error: 'effectiveDate is not a valid date.' });
      if (resolvedDate < today) return res.status(400).json({ error: 'effectiveDate cannot be in the past.' });
    }
    const isImmediate = resolvedDate.getTime() <= today.getTime();

    // PERFORMANCE FIX (item 6 from the codebase review: sequential
    // background-job loops). This used to process one unit at a time
    // via a plain `for...of` + `await`, so a landlord with a few
    // hundred units in one property would wait on hundreds of
    // sequential round-trips. runInBatches (already used by the daily
    // cron jobs - see monthlyBilling.job.js, rentReminders.job.js,
    // subscriptionReminders.job.js, portfolioDigest.job.js, and
    // tenant.controller.js's own bulk endpoint) runs a bounded number
    // of units concurrently instead, without opening an unbounded
    // number of simultaneous connections to Supabase. A single unit's
    // failure is caught per-item (same as before) so it can't abort
    // the rest of the batch.
    let updated = 0;
    let skipped = 0;
    const unitsToUpdate = [];
    for (const unit of units) {
      const currentAmount = Number(unit.rent_amount || 0);
      const newAmount = flatNewAmount != null
        ? Number(flatNewAmount)
        : Math.round(currentAmount * (1 + Number(percentIncrease) / 100));
      if (newAmount <= 0 || newAmount === currentAmount) {
        skipped += 1;
        continue;
      }
      unitsToUpdate.push({ unit, newAmount });
    }

    await runInBatches(
      unitsToUpdate,
      async ({ unit, newAmount }) => {
        await applyRentChangeToUnit(unit, { newRentAmount: newAmount, resolvedDate, isImmediate, actorRole: req.user.role, actorId: req.user.id, landlordId });
        updated += 1;
      },
      {
        concurrency: 15,
        onError: (err, { unit }) => {
          logger.error(`[unit] bulkUpdateRent: failed for unit ${unit.id}:`, err.message);
          captureException(err);
          skipped += 1;
        },
      }
    );

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'bulk_rent_updated',
      targetType: 'property',
      targetId: propertyId || null,
      metadata: { updated, skipped, percentIncrease: percentIncrease ?? null, flatNewAmount: flatNewAmount ?? null },
    });

    return res.json({
      message: isImmediate
        ? `Rent updated for ${updated} unit${updated === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped)` : ''}.`
        : `Rent change scheduled for ${updated} unit${updated === 1 ? '' : 's'}, effective ${resolvedDate.toLocaleDateString('en-GB')}.`,
      updated,
      skipped,
    });
  } catch (err) {
    logger.error('[unit] bulkUpdateRent error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to bulk update rent.' });
  }
}

// ---------------------------------------------------------------------
// APPLY SCHEDULED RENT CHANGES - called daily (see monthlyBilling.job.js)
// to flip any 'pending' rent_changes whose effective_date has arrived
// into the unit's live rent_amount, marking them 'applied'. This is
// the piece that makes "next month" / a custom future date a REAL
// deferred change instead of just different wording on an immediate one.
// ---------------------------------------------------------------------
async function applyScheduledRentChanges() {
  const todayStr = new Date().toISOString().slice(0, 10);

  const { data: due, error } = await supabase
    .from('rent_changes')
    .select('*')
    .eq('status', 'pending')
    .lte('effective_date', todayStr);

  if (error) {
    logger.error('[unit] applyScheduledRentChanges: failed to fetch due changes:', error.message);
    captureException(error);
    return;
  }

  // PERFORMANCE FIX (item 6 from the codebase review: sequential
  // background-job loops). Same reasoning as bulkUpdateRent above -
  // this is a daily cron step (see monthlyBilling.job.js), and a
  // portfolio with many rent changes landing on the same day used to
  // apply them one at a time. runInBatches bounds the concurrency
  // instead of either serializing everything or firing every change
  // at once.
  await runInBatches(
    due || [],
    async (change) => {
      const { data: updatedUnit, error: updateError } = await supabase
        .from('units')
        .update({ rent_amount: change.new_amount })
        .eq('id', change.unit_id)
        .select('unit_name, property_id')
        .single();
      if (updateError) throw updateError;

      await supabase.from('rent_changes').update({ status: 'applied', applied_at: new Date().toISOString() }).eq('id', change.id);

      const { data: tenant } = await supabase.from('tenants').select('*').eq('unit_id', change.unit_id).eq('is_active', true).maybeSingle();
      if (tenant) {
        const msg = templates.rentAltered(tenant.full_name, change.new_amount, 'today, as previously scheduled');
        await notify('tenant', tenant.id, tenant.primary_phone, msg, { category: 'account', title: 'Rent Change Applied' });
      }

      await postSystemAnnouncement(
        change.landlord_id,
        `Rent for Unit ${updatedUnit?.unit_name || ''} has changed to KES ${Number(change.new_amount).toLocaleString()}, effective today (as previously scheduled).`,
        { unitId: change.unit_id, propertyId: updatedUnit?.property_id || null }
      );
    },
    {
      concurrency: 15,
      onError: (err, change) => {
        logger.error(`[unit] applyScheduledRentChanges: failed to apply change ${change.id}:`, err.message);
        captureException(err);
      },
    }
  );
}

// ---------------------------------------------------------------------
// UPDATE DUE DATE (blueprint 7.3: "Tenant notified automatically")
// Previously did not exist at all - due_day_of_month could only be set
// at unit-creation time, never changed afterward.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// LIST PENDING RENT CHANGES - portfolio-wide view of every scheduled
// (not yet applied) rent change. getUnit() above already surfaces a
// single unit's own pending change, but there was no way to see "what
// rent changes are coming up across my whole portfolio" without
// opening every unit one at a time. Read-only - actually scheduling a
// change is still done via updateRent/bulkUpdateRent above.
// ---------------------------------------------------------------------
async function listPendingRentChanges(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId } = req.query;
    const isManager = req.user.role === 'manager';

    let assignedPropertyIds = null;
    if (isManager) {
      assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (propertyId && !assignedPropertyIds.includes(propertyId)) {
        return res.status(403).json({ error: 'You have not been given access to this property.' });
      }
    }

    let unitsQuery = supabase.from('units').select('id, unit_name, property_id, properties(name)').eq('landlord_id', landlordId);
    if (propertyId) unitsQuery = unitsQuery.eq('property_id', propertyId);
    else if (isManager) {
      if (assignedPropertyIds.length === 0) return res.json({ changes: [] });
      unitsQuery = unitsQuery.in('property_id', assignedPropertyIds);
    }
    const { data: units, error: unitsError } = await unitsQuery;
    if (unitsError) throw unitsError;

    const unitIds = (units || []).map((u) => u.id);
    if (unitIds.length === 0) return res.json({ changes: [] });
    const unitById = new Map(units.map((u) => [u.id, u]));

    const { data: changes, error } = await supabase
      .from('rent_changes')
      .select('*')
      .eq('status', 'pending')
      .in('unit_id', unitIds)
      .order('effective_date', { ascending: true });
    if (error) throw error;

    const enriched = (changes || []).map((c) => ({
      ...c,
      unitName: unitById.get(c.unit_id)?.unit_name || null,
      propertyName: unitById.get(c.unit_id)?.properties?.name || null,
    }));

    return res.json({ changes: enriched });
  } catch (err) {
    logger.error('[unit] listPendingRentChanges error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch scheduled rent changes.' });
  }
}

async function updateDueDate(req, res) {
  try {
    const { unitId } = req.params;
    const { newDueDayOfMonth } = req.body;
    const landlordId = effectiveLandlordId(req);

    if (!newDueDayOfMonth || newDueDayOfMonth < 1 || newDueDayOfMonth > 28) {
      return res.status(400).json({ error: 'newDueDayOfMonth must be between 1 and 28.' });
    }

    const { data: unit, error: fetchError } = await supabase.from('units').select('*').eq('id', unitId).single();
    if (fetchError || !unit) return res.status(404).json({ error: 'Unit not found.' });
    if (unit.landlord_id !== landlordId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not own this unit.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, unit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    if (unit.is_frozen) {
      return res.status(400).json({ error: 'This unit is frozen because your current subscription covers fewer units than you have. Renew or upgrade your subscription to unlock it.' });
    }

    const { error: updateError } = await supabase.from('units').update({ due_day_of_month: newDueDayOfMonth }).eq('id', unitId);
    if (updateError) throw updateError;

    const { data: tenant } = await supabase.from('tenants').select('*').eq('unit_id', unitId).eq('is_active', true).maybeSingle();
    if (tenant) {
      await notify(
        'tenant',
        tenant.id,
        tenant.primary_phone,
        `Hi ${tenant.full_name}, your rent due date has changed to day ${newDueDayOfMonth} of each month.`,
        { category: 'account', title: 'Due Date Change' }
      );
    }

    await postSystemAnnouncement(
      landlordId,
      `The rent due date for Unit ${unit.unit_name} has changed to day ${newDueDayOfMonth} of each month.`,
      { unitId, propertyId: unit.property_id || null }
    );

    logActivity({ actorType: req.user.role, actorId: landlordId, action: 'due_date_updated', targetType: 'unit', targetId: unitId, metadata: { newDueDayOfMonth } });

    return res.json({ message: 'Due date updated.', tenantNotified: !!tenant });
  } catch (err) {
    logger.error('[unit] updateDueDate error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update due date.' });
  }
}

// ---------------------------------------------------------------------
// BULK DUE DATE CHANGE (direct request: a landlord/manager with many
// units having to set the rent due date "one by one" is hectic with
// hundreds of units). Same shape and reasoning as bulkUpdateRent above
// - one pass across every unit in a property (or every unit the
// caller owns/manages, if no property is given), reusing the exact
// same per-unit notification/announcement/activity-log behavior as
// the single-unit updateDueDate endpoint so tenants are still
// notified individually, just done in one request instead of
// hundreds. Frozen units and units already on the target day are
// skipped (not errored) rather than failing the whole batch.
// ---------------------------------------------------------------------
async function bulkUpdateDueDate(req, res) {
  try {
    const { propertyId, unitIds, newDueDayOfMonth } = req.body;
    const landlordId = effectiveLandlordId(req);
    const scopedUnitIds = Array.isArray(unitIds) && unitIds.length > 0 ? unitIds : null;

    const dueDay = Number(newDueDayOfMonth);
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) {
      return res.status(400).json({ error: 'newDueDayOfMonth must be a whole number between 1 and 28.' });
    }

    const isManager = req.user.role === 'manager';
    const assignedPropertyIds = isManager ? await getManagerAssignedPropertyIds(req.user.id) : [];
    if (propertyId && isManager && !assignedPropertyIds.includes(propertyId)) {
      return res.status(403).json({ error: 'You do not manage this property.' });
    }

    let unitsQuery = supabase.from('units').select('*').eq('landlord_id', landlordId);
    if (scopedUnitIds) {
      unitsQuery = unitsQuery.in('id', scopedUnitIds);
    } else if (propertyId) {
      unitsQuery = unitsQuery.eq('property_id', propertyId);
    } else if (isManager) {
      if (assignedPropertyIds.length === 0) return res.json({ message: 'No units to update.', updated: 0, skipped: 0 });
      unitsQuery = unitsQuery.in('property_id', assignedPropertyIds);
    }
    const { data: units, error: unitsErr } = await unitsQuery;
    if (unitsErr) throw unitsErr;
    if (!units || units.length === 0) {
      return res.json({ message: 'No units to update.', updated: 0, skipped: 0 });
    }
    if (scopedUnitIds && isManager) {
      const disallowed = units.some((u) => !assignedPropertyIds.includes(u.property_id));
      if (disallowed) return res.status(403).json({ error: 'You do not manage one or more of the selected units.' });
    }

    let updated = 0;
    let skipped = 0;
    const unitsToUpdate = units.filter((u) => {
      if (u.is_frozen) { skipped += 1; return false; }
      if (Number(u.due_day_of_month) === dueDay) { skipped += 1; return false; }
      return true;
    });

    await runInBatches(
      unitsToUpdate,
      async (unit) => {
        const { error: updateError } = await supabase.from('units').update({ due_day_of_month: dueDay }).eq('id', unit.id);
        if (updateError) throw updateError;

        const { data: tenant } = await supabase.from('tenants').select('*').eq('unit_id', unit.id).eq('is_active', true).maybeSingle();
        if (tenant) {
          await notify(
            'tenant',
            tenant.id,
            tenant.primary_phone,
            `Hi ${tenant.full_name}, your rent due date has changed to day ${dueDay} of each month.`,
            { category: 'account', title: 'Due Date Change' }
          );
        }

        await postSystemAnnouncement(
          landlordId,
          `The rent due date for Unit ${unit.unit_name} has changed to day ${dueDay} of each month.`,
          { unitId: unit.id, propertyId: unit.property_id || null }
        );

        updated += 1;
      },
      {
        concurrency: 15,
        onError: (err, unit) => {
          logger.error(`[unit] bulkUpdateDueDate: failed for unit ${unit.id}:`, err.message);
          captureException(err);
          skipped += 1;
        },
      }
    );

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'bulk_due_date_updated',
      targetType: 'property',
      targetId: propertyId || null,
      metadata: { updated, skipped, newDueDayOfMonth: dueDay },
    });

    return res.json({
      message: `Due date set to day ${dueDay} of each month for ${updated} unit${updated === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped)` : ''}.`,
      updated,
      skipped,
    });
  } catch (err) {
    logger.error('[unit] bulkUpdateDueDate error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to bulk update due date.' });
  }
}

// ---------------------------------------------------------------------
// MARK UNIT STATUS (vacant / maintenance / occupied / notice_given)
// ---------------------------------------------------------------------
async function updateUnitStatus(req, res) {
  try {
    const { unitId } = req.params;
    const { status } = req.body;
    const validStatuses = ['occupied', 'notice_given', 'vacant', 'maintenance'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    // Item 8: a unit can't be marked vacant or sent to maintenance
    // while it still has an active tenant - the tenant has to be
    // removed first. This checks for a live tenant row rather than
    // trusting the unit's current status label alone, since a unit
    // marked "notice_given" still has an active tenant living there
    // too (they've just given notice, they haven't left yet).
    if (status === 'vacant' || status === 'maintenance') {
      const { data: activeTenant } = await supabase
        .from('tenants')
        .select('id')
        .eq('unit_id', unitId)
        .eq('is_active', true)
        .maybeSingle();
      if (activeTenant) {
        return res.status(400).json({ error: 'This unit still has an active tenant. Remove the tenant first before marking it vacant or under maintenance.' });
      }
    }

    // CRITICAL FIX (isolation audit): this endpoint previously updated
    // ANY unit by id with no ownership check at all - any landlord or
    // manager account on the platform could change the status of a
    // unit belonging to a completely different landlord. Loads the
    // unit's landlord_id/property_id up front so both the landlord and
    // manager-property-assignment checks can run before anything is
    // written, same pattern as getUnit/renameUnit/updatePaymentOverride.
    const { data: existingUnit } = await supabase
      .from('units')
      .select('is_frozen, landlord_id, property_id, is_publicly_listed, properties(county)')
      .eq('id', unitId)
      .maybeSingle();
    if (!existingUnit) return res.status(404).json({ error: 'Unit not found.' });
    const ownershipError = await checkLandlordOwnership(req, existingUnit.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, existingUnit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    if (existingUnit.is_frozen) {
      return res.status(400).json({ error: 'This unit is frozen because your current subscription covers fewer units than you have. Renew or upgrade your subscription to unlock it.' });
    }

    const { data: unit, error } = await supabase
      .from('units')
      .update({ status })
      .eq('id', unitId)
      .select('unit_name, property_id, landlord_id')
      .single();
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'unit_status_changed', targetType: 'unit', targetId: unitId, metadata: { status } });

    // Only statuses that actually mean something to a tenant are worth
    // an automatic update - "maintenance"/"vacant" on someone else's
    // unit isn't relevant to the tenant living in it, but notice being
    // given directly affects them.
    if (status === 'notice_given' && unit) {
      await postSystemAnnouncement(unit.landlord_id, `A vacating notice has been recorded for Unit ${unit.unit_name}.`, {
        unitId,
        propertyId: unit.property_id || null,
      });
    }

    // Item 8: alert the rest of the account (landlord/manager/
    // caretaker, whichever of them didn't make this change themselves)
    // whenever a unit goes vacant, instead of only the person who
    // clicked the button finding out.
    if (status === 'vacant' && unit) {
      await postSystemAnnouncement(unit.landlord_id, `Unit ${unit.unit_name} has been marked vacant and is ready for a new tenant.`, {
        propertyId: unit.property_id || null,
      });

      // DIRECT REQUEST: "browser popups... to receive browser
      // notifications when a unit goes vacant around them". Only
      // fires for units the landlord/manager has kept public -
      // respects the same is_publicly_listed opt-out used on the
      // /find-a-house page itself (see add-unit-public-listing-toggle.sql).
      // Fire-and-forget: this is a "nice to have" reach-out to
      // anonymous browsers, never allowed to slow down or fail this
      // request (see notifyVacancyAlertSubscribers's own try/catch -
      // it never throws either, this catch is just belt-and-braces).
      if (existingUnit.is_publicly_listed) {
        notifyVacancyAlertSubscribers({
          unitId,
          unitName: unit.unit_name,
          county: existingUnit.properties?.county || null,
        }).catch(() => {});
      }
    }

    return res.json({ message: `Unit marked as ${status}.` });
  } catch (err) {
    logger.error('[unit] updateUnitStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update unit status.' });
  }
}

// ---------------------------------------------------------------------
// VERIFY UNIT (spec §2: freshness) - landlord/manager/caretaker taps
// "Still vacant - confirm" to stamp last_verified_at, separate from
// updated_at so viewers can tell "confirmed still vacant" apart from
// "someone merely edited this record". Deliberately allowed on a unit
// in any status, not just 'vacant' - the button is expected to live on
// the unit's own row regardless of current status, and confirming
// freshness on an occupied/maintenance unit is harmless, just a no-op.
// ---------------------------------------------------------------------
async function verifyUnit(req, res) {
  try {
    const { unitId } = req.params;

    const { data: existingUnit } = await supabase.from('units').select('landlord_id, property_id').eq('id', unitId).maybeSingle();
    if (!existingUnit) return res.status(404).json({ error: 'Unit not found.' });
    const ownershipError = await checkLandlordOwnership(req, existingUnit.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, existingUnit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const now = new Date().toISOString();
    const { error } = await supabase.from('units').update({ last_verified_at: now }).eq('id', unitId);
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'unit_verified', targetType: 'unit', targetId: unitId });

    return res.json({ message: 'Unit confirmed as still vacant.', lastVerifiedAt: now });
  } catch (err) {
    logger.error('[unit] verifyUnit error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to verify unit.' });
  }
}

// ---------------------------------------------------------------------
// REMOVE UNIT (blueprint 7.3: must be vacant first; 9.3: must remove tenant first)
// ---------------------------------------------------------------------
async function removeUnit(req, res) {
  try {
    const { unitId } = req.params;

    // CRITICAL FIX (isolation audit): previously deleted ANY unit by id
    // with no ownership check at all - any landlord/manager account
    // could permanently delete another landlord's unit. Same pattern as
    // updateUnitStatus's fix above.
    const { data: unit, error: fetchError } = await supabase.from('units').select('status, landlord_id, property_id').eq('id', unitId).single();
    if (fetchError || !unit) return res.status(404).json({ error: 'Unit not found.' });
    const ownershipError = await checkLandlordOwnership(req, unit.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, unit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    if (unit.status === 'occupied') {
      return res.status(400).json({ error: 'Remove tenant first before removing this unit.' });
    }

    const { error } = await supabase.from('units').delete().eq('id', unitId);
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'unit_removed', targetType: 'unit', targetId: unitId });

    return res.json({ message: 'Unit removed.' });
  } catch (err) {
    logger.error('[unit] removeUnit error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to remove unit.' });
  }
}

// ---------------------------------------------------------------------
// ADD EXTRA CHARGE (water/garbage/security/electricity - blueprint 6.1, 7.3)
//
// FEATURE (spec item 12): a landlord can now scope a charge beyond the
// single unit they're viewing - either every unit in the property
// currently in view, or a hand-picked set of that property's units -
// instead of repeating this action once per unit. `scope` in the body
// controls this: 'unit' (default, unchanged single-unit behavior),
// 'property' (every non-frozen unit on the same property as :unitId),
// or 'units' (exactly the unitIds given, each validated to belong to
// that same property). Whichever units end up affected, each one goes
// through the exact same per-unit logic as before - append to that
// unit's extra_charges, and (per the earlier fix for item 11) top up
// the active tenant's balance_due immediately if they've already been
// billed this cycle - so this integrates with item 11 automatically:
// however many units the charge lands on, each affected tenant sees
// it the same way a single-unit charge already does.
// ---------------------------------------------------------------------
async function applyExtraChargeToUnit(unit, { name, amount, recurring, currentPeriod }) {
  const updatedCharges = [...(unit.extra_charges || [])];

  if (recurring) {
    updatedCharges.push({ name, amount, recurring: true });
    const { error } = await supabase.from('units').update({ extra_charges: updatedCharges }).eq('id', unit.id);
    if (error) throw error;

    const { data: tenant } = await supabase
      .from('tenants')
      .select('id, balance_due, last_billed_period')
      .eq('unit_id', unit.id)
      .eq('is_active', true)
      .maybeSingle();

    if (tenant && tenant.last_billed_period === currentPeriod) {
      const newBalance = Math.round((Number(tenant.balance_due || 0) + amount) * 100) / 100;
      const { error: balanceError } = await supabase.from('tenants').update({ balance_due: newBalance }).eq('id', tenant.id);
      if (balanceError) throw balanceError;
    }
    return { billedTenant: false, updatedCharges };
  }

  // One-time charge: billed exactly once, right now, directly onto
  // whoever currently occupies the unit - never written into the
  // unit's persistent extra_charges list, so nothing here can ever
  // repeat on a future month's bill.
  const { data: tenant } = await supabase.from('tenants').select('id, balance_due').eq('unit_id', unit.id).eq('is_active', true).maybeSingle();
  if (!tenant) return { billedTenant: false, updatedCharges: unit.extra_charges || [], noTenant: true };

  const newBalance = Math.round((Number(tenant.balance_due || 0) + amount) * 100) / 100;
  const { error } = await supabase.from('tenants').update({ balance_due: newBalance }).eq('id', tenant.id);
  if (error) throw error;
  return { billedTenant: true, updatedCharges: unit.extra_charges || [] };
}

async function addExtraCharge(req, res) {
  try {
    const { unitId } = req.params;
    const { name, amount, recurring = true, scope = 'unit', unitIds } = req.body;

    if (!name || amount == null) {
      return res.status(400).json({ error: 'name and amount are required.' });
    }
    const validatedChargeAmount = validatePositiveAmount(amount, { allowZero: true });
    if (validatedChargeAmount === null) {
      return res.status(400).json({ error: 'amount must be a valid non-negative number.' });
    }
    if (!['unit', 'property', 'units'].includes(scope)) {
      return res.status(400).json({ error: "scope must be 'unit', 'property', or 'units'." });
    }
    if (scope === 'units' && (!Array.isArray(unitIds) || unitIds.length === 0)) {
      return res.status(400).json({ error: 'unitIds is required when scope is "units".' });
    }

    const { data: unit, error: fetchError } = await supabase.from('units').select('extra_charges, unit_name, property_id, landlord_id, is_frozen').eq('id', unitId).single();
    if (fetchError || !unit) return res.status(404).json({ error: 'Unit not found.' });
    // CRITICAL FIX (isolation audit): this had NO ownership check at
    // all, and the one-time-charge branch below writes straight to
    // tenants.balance_due - without this, any landlord/manager account
    // could bill money onto a tenant belonging to a different landlord
    // entirely.
    const ownershipError = await checkLandlordOwnership(req, unit.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, unit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    // Resolve the full set of target units for this charge.
    let targetUnits;
    if (scope === 'unit') {
      if (unit.is_frozen) {
        return res.status(400).json({ error: 'This unit is frozen because your current subscription covers fewer units than you have. Renew or upgrade your subscription to unlock it.' });
      }
      targetUnits = [{ id: unitId, extra_charges: unit.extra_charges, unit_name: unit.unit_name }];
    } else {
      if (!unit.property_id) {
        return res.status(400).json({ error: 'This unit is not part of a property, so a property-wide or multi-unit charge cannot be applied.' });
      }
      let query = supabase
        .from('units')
        .select('id, extra_charges, unit_name, is_frozen')
        .eq('property_id', unit.property_id)
        .eq('landlord_id', unit.landlord_id);
      if (scope === 'units') query = query.in('id', unitIds);
      const { data: propertyUnits, error: unitsError } = await query;
      if (unitsError) throw unitsError;

      if (scope === 'units') {
        // Every requested id must actually belong to this property -
        // otherwise a landlord could smuggle in a unit from a
        // different property (or one they don't own) by id.
        const foundIds = new Set((propertyUnits || []).map((u) => u.id));
        const missing = unitIds.filter((id) => !foundIds.has(id));
        if (missing.length > 0) {
          return res.status(400).json({ error: 'One or more selected units do not belong to this property.' });
        }
      }
      targetUnits = propertyUnits || [];
    }

    const frozenSkipped = targetUnits.filter((u) => u.is_frozen).map((u) => u.unit_name);
    const applicableUnits = targetUnits.filter((u) => !u.is_frozen);
    if (applicableUnits.length === 0) {
      return res.status(400).json({ error: 'Every selected unit is frozen (subscription covers fewer units than you have) - nothing to charge.' });
    }

    const today = new Date();
    const currentPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    let primaryUnitCharges = unit.extra_charges || [];
    let unitsWithNoTenant = [];
    let batchError = null;

    await runInBatches(
      applicableUnits,
      async (u) => {
        const result = await applyExtraChargeToUnit(u, { name, amount: validatedChargeAmount, recurring, currentPeriod });
        if (u.id === unitId) primaryUnitCharges = result.updatedCharges;
        if (result.noTenant) unitsWithNoTenant.push(u.unit_name);
      },
      {
        concurrency: 5,
        // runInBatches never rejects on its own - a failed item is
        // caught and handed to onError so one bad unit can't silently
        // abort the whole batch. We still want a real charge-money
        // failure to surface as a 500 rather than reporting success,
        // so the first error is captured here and re-thrown after the
        // batch finishes, landing in this function's own catch block.
        onError: (err, u) => {
          if (!batchError) batchError = err;
          logger.error(`[unit] addExtraCharge: failed to apply charge to unit ${u.id}:`, err.message);
        },
      }
    );

    if (batchError) throw batchError;

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'extra_charge_added',
      targetType: 'unit',
      targetId: unitId,
      metadata: { name, amount, recurring: !!recurring, scope, unitsAffected: applicableUnits.length },
    });

    await postSystemAnnouncement(
      unit.landlord_id,
      applicableUnits.length > 1
        ? `A new ${recurring ? '' : 'one-time '}charge "${name}" of KES ${Number(amount).toLocaleString()} has been added to ${applicableUnits.length} units.`
        : `A new ${recurring ? '' : 'one-time '}charge "${name}" of KES ${Number(amount).toLocaleString()} has been added to Unit ${unit.unit_name}.`,
      { unitId, propertyId: unit.property_id || null }
    );

    return res.json({
      message: recurring
        ? `Recurring charge added to ${applicableUnits.length} unit${applicableUnits.length === 1 ? '' : 's'}.`
        : `One-time charge billed to ${applicableUnits.length} unit${applicableUnits.length === 1 ? '' : 's'}.`,
      extraCharges: primaryUnitCharges,
      unitsAffected: applicableUnits.length,
      skippedFrozenUnits: frozenSkipped,
      unitsWithNoTenant, // one-time charges only - which affected units had no active tenant to bill
    });
  } catch (err) {
    logger.error('[unit] addExtraCharge error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to add extra charge.' });
  }
}

// ---------------------------------------------------------------------
// GET SINGLE UNIT (for the unit detail page - status, tenant, charges,
// payment history all in one call)
// ---------------------------------------------------------------------
async function getUnit(req, res) {
  try {
    const { unitId } = req.params;

    const { data: unit, error } = await supabase.from('units').select('*').eq('id', unitId).single();

    if (error || !unit) return res.status(404).json({ error: 'Unit not found.' });
    if (unit.landlord_id !== effectiveLandlordId(req) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not own this unit.' });
    }

    // FIX: a manager/caretaker opening a unit directly (e.g. a saved
    // link, or browser back/forward) must be blocked the same way the
    // unit list already is if that unit's property isn't one they're
    // assigned to. Units not grouped under any property are left open
    // to all of the landlord's managers, same as everywhere else.
    if (req.user.role === 'manager' && unit.property_id) {
      const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (!assignedPropertyIds.includes(unit.property_id)) {
        return res.status(403).json({
          error: 'You have not been given access to this property. Contact the landlord if you believe this is a mistake.',
          notAssigned: true,
        });
      }
    }

    // Queried separately rather than via a PostgREST embedded join
    // (e.g. 'tenants!tenants_unit_id_fkey(*)') - that syntax depends on
    // guessing Postgres's auto-generated foreign-key constraint name,
    // which varies depending on how the table was created and was
    // causing EVERY call to this endpoint to fail with a false 404
    // (the query itself errored, which the code below correctly but
    // misleadingly reported as "unit not found").
    //
    // PERFORMANCE FIX: these two don't depend on each other - fired
    // together instead of one after another, same reasoning as the
    // dashboard load fix.
    const [{ data: tenants }, { data: payments }] = await Promise.all([
      supabase.from('tenants').select('*').eq('unit_id', unitId),
      supabase.from('payments').select('*').eq('unit_id', unitId).order('created_at', { ascending: false }).limit(20),
    ]);

    const sanitizedTenants = (tenants || []).map((t) => ({ ...t, password_hash: undefined, otp_code: undefined }));

    // Surface any not-yet-applied scheduled rent change so the landlord
    // portal can show "Change to KES X takes effect on Y" instead of
    // silently sitting in the rent_changes table with no visibility.
    const { data: pendingRentChange } = await supabase
      .from('rent_changes')
      .select('*')
      .eq('unit_id', unitId)
      .eq('status', 'pending')
      .order('effective_date', { ascending: true })
      .limit(1)
      .maybeSingle();

    return res.json({
      unit: { ...unit, tenants: sanitizedTenants },
      payments: payments || [],
      pendingRentChange: pendingRentChange || null,
    });
  } catch (err) {
    logger.error('[unit] getUnit error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch unit.' });
  }
}

// ---------------------------------------------------------------------
// NOTE: unit renaming was removed by direct request - unit_name is
// write-once again (set at creation, no PATCH .../name route exists
// anymore). See git history for the old renameUnit if it's ever
// needed again.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// UNIT-LEVEL PAYMENT METHOD OVERRIDE
//
// The general/default payment method (Settings -> Payment method)
// still applies to every unit by default. This lets a landlord or
// (full) property manager set a DIFFERENT method + Paybill/Till/
// account number for one specific unit only - that unit's tenant then
// only ever sees the override, every other tenant keeps seeing the
// general default untouched. Caretakers may view this (it's part of
// getUnit's normal select('*')) but never edit it - same rule as the
// general payment method being caretaker-read-only.
// ---------------------------------------------------------------------
async function updatePaymentOverride(req, res) {
  try {
    const { unitId } = req.params;
    const { enabled, method, paybillNumber, accountNumber, tillNumber, description } = req.body;
    const landlordId = effectiveLandlordId(req);

    const { data: unit, error: fetchError } = await supabase.from('units').select('landlord_id, unit_name, property_id, is_frozen').eq('id', unitId).single();
    if (fetchError || !unit) return res.status(404).json({ error: 'Unit not found.' });
    if (unit.landlord_id !== landlordId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not own this unit.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, unit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    if (unit.is_frozen) {
      return res.status(400).json({ error: 'This unit is frozen because your current subscription covers fewer units than you have. Renew or upgrade your subscription to unlock it.' });
    }

    const updateFields = { payment_override_enabled: !!enabled };

    if (enabled) {
      if (!['stk', 'paybill', 'till'].includes(method)) {
        return res.status(400).json({ error: "method must be 'stk', 'paybill', or 'till'." });
      }
      updateFields.payment_override_method = method;
      updateFields.payment_override_paybill_number = method === 'paybill' ? paybillNumber || null : null;
      updateFields.payment_override_paybill_account_number = method === 'paybill' ? accountNumber || null : null;
      updateFields.payment_override_till_number = method === 'till' ? tillNumber || null : null;
      // Direct request: same "set once, show to tenant when they tap
      // Pay Rent" description field as the account/apartment levels,
      // available per-unit too since a unit override already means
      // "this one unit is different from the rest."
      if (description !== undefined) updateFields.payment_override_description = description || null;
    }
    // When switching the override off, the saved override values are
    // deliberately left in place (not wiped) - flipping it back on
    // later restores what was there before instead of forcing the
    // landlord to re-enter it.

    const { error: updateError } = await supabase.from('units').update(updateFields).eq('id', unitId);
    if (updateError) throw updateError;

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: enabled ? 'unit_payment_override_set' : 'unit_payment_override_cleared',
      targetType: 'unit',
      targetId: unitId,
    });

    if (enabled) {
      const { data: tenant } = await supabase.from('tenants').select('id, full_name, primary_phone').eq('unit_id', unitId).eq('is_active', true).maybeSingle();
      const methodLabel = method === 'paybill'
        ? `Paybill ${paybillNumber || ''}${accountNumber ? ` (Account: ${accountNumber})` : ''}`
        : method === 'till'
          ? `Till Number ${tillNumber || ''}`
          : 'STK Push';
      if (tenant) {
        await notify(
          'tenant',
          tenant.id,
          tenant.primary_phone,
          `Hi ${tenant.full_name}, the payment method for your unit has been updated to: ${methodLabel}.`,
          { category: 'account', title: 'Payment Method Updated' }
        );
      }
      await postSystemAnnouncement(landlordId, `The payment method for Unit ${unit.unit_name} has been updated to: ${methodLabel}.`, {
        unitId,
        propertyId: unit.property_id || null,
      });
    }

    return res.json({ message: enabled ? 'Payment override saved for this unit.' : 'This unit now uses the general default payment method.' });
  } catch (err) {
    logger.error('[unit] updatePaymentOverride error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update payment override.' });
  }
}

// ---------------------------------------------------------------------
// UPDATE PUBLIC LISTING (DIRECT REQUEST: "add an option in the
// landlord/manager portal that they choose whether their vacant units
// should be listed public or not"). Toggles units.is_publicly_listed -
// see add-unit-public-listing-toggle.sql. Purely cosmetic to who can
// SEE the unit on /find-a-house (public.controller.js enforces it
// server-side on every public read); it has no effect on the unit's
// actual status/occupancy, so it's safe to flip at any time, occupied
// or not - it just determines whether a FUTURE vacancy would show up
// there.
// ---------------------------------------------------------------------
async function updatePublicListing(req, res) {
  try {
    const { unitId } = req.params;
    const { isPubliclyListed } = req.body;

    if (typeof isPubliclyListed !== 'boolean') {
      return res.status(400).json({ error: 'isPubliclyListed must be true or false.' });
    }

    const { data: existingUnit } = await supabase.from('units').select('landlord_id, property_id').eq('id', unitId).maybeSingle();
    if (!existingUnit) return res.status(404).json({ error: 'Unit not found.' });
    const ownershipError = await checkLandlordOwnership(req, existingUnit.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, existingUnit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const { error } = await supabase.from('units').update({ is_publicly_listed: isPubliclyListed }).eq('id', unitId);
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'unit_public_listing_changed', targetType: 'unit', targetId: unitId, metadata: { isPubliclyListed } });

    return res.json({
      message: isPubliclyListed
        ? 'This unit will show on the public listings page whenever it is vacant.'
        : 'This unit is now private and will never show on the public listings page.',
      isPubliclyListed,
    });
  } catch (err) {
    logger.error('[unit] updatePublicListing error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update the listing setting.' });
  }
}

// ---------------------------------------------------------------------
// UPDATE LISTING STATUS (DIRECT REQUEST): landlord/manager/caretaker
// confirms whether a vacant unit is "still active" (open to new
// inquiries), "already booked" (someone has committed, but the unit
// hasn't been filled in/marked occupied yet), or "planned for"
// (earmarked, not really open right now). This is shown alongside the
// unit wherever it's listed as vacant - see
// 2026-07-property-reputation-listing-status-deposit.sql for why this
// is deliberately separate from units.status and last_verified_at.
//
// The moment a tenant is actually filled in and units.status flips to
// 'occupied' (see addTenant in tenant.controller.js), the unit drops
// out of every vacant-unit listing regardless of listing_status - so
// nothing here needs to reset it back to 'active' on move-out; a unit
// going vacant again naturally starts a fresh cycle whenever a
// landlord next confirms it.
//
// CONFIRMED (not an oversight): a unit that cycles vacant -> occupied ->
// vacant again keeps whatever listing_status it last had (e.g. still
// 'booked' or 'planned' from before) until someone explicitly calls this
// endpoint again. We deliberately do NOT auto-reset to 'active' on the
// occupied -> vacant transition, since a fresh vacancy should be
// manually re-confirmed rather than silently assumed open. If this ever
// needs to change, the reset would belong wherever units.status flips
// back to 'vacant' (tenant removal/move-out), not here.
// ---------------------------------------------------------------------
async function updateListingStatus(req, res) {
  try {
    const { unitId } = req.params;
    const { listingStatus } = req.body;

    const allowed = ['active', 'booked', 'planned'];
    if (!allowed.includes(listingStatus)) {
      return res.status(400).json({ error: `listingStatus must be one of: ${allowed.join(', ')}.` });
    }

    const { data: existingUnit } = await supabase.from('units').select('landlord_id, property_id, status').eq('id', unitId).maybeSingle();
    if (!existingUnit) return res.status(404).json({ error: 'Unit not found.' });
    const ownershipError = await checkLandlordOwnership(req, existingUnit.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, existingUnit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    // req.user.role is 'landlord' | 'manager' | 'admin' here (route allows
    // all three). For managers, roleLevel further distinguishes 'manager'
    // vs 'caretaker'. Falling anything unrecognized through to 'landlord'
    // would misattribute admin-driven changes, so admin is handled
    // explicitly rather than defaulting into it.
    const roleLevel = req.user.role === 'manager' ? (req.user.roleLevel || 'manager') : req.user.role;
    const updatedByType = ['manager', 'caretaker', 'admin'].includes(roleLevel) ? roleLevel : 'landlord';

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('units')
      .update({
        listing_status: listingStatus,
        listing_status_updated_at: now,
        listing_status_updated_by_type: updatedByType,
        listing_status_updated_by_id: req.user.id,
      })
      .eq('id', unitId);
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'unit_listing_status_changed', targetType: 'unit', targetId: unitId, metadata: { listingStatus } });

    return res.json({ message: `Unit confirmed as ${listingStatus}.`, listingStatus, listingStatusUpdatedAt: now });
  } catch (err) {
    logger.error('[unit] updateListingStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update listing status.' });
  }
}

// ---------------------------------------------------------------------
// UPDATE LISTING DESCRIPTION (SEO/direct request: "richer listing page
// content" - real, unique text per unit, e.g. nearby landmarks, water
// reliability, security setup). Free-text and optional; landlord/
// manager/caretaker is the only one who can supply it, since only they
// actually know real details about that specific property. Capped at
// 1000 chars - long enough for a genuinely useful paragraph, short
// enough to discourage pasting in something unrelated. Trimmed empty
// string is stored as null rather than '', so "has a description or
// not" stays a clean boolean check everywhere else (public listings
// page, schema markup) rather than needing an extra `.trim()` there too.
// ---------------------------------------------------------------------
async function updateListingDescription(req, res) {
  try {
    const { unitId } = req.params;
    const { listingDescription } = req.body;

    if (listingDescription !== null && typeof listingDescription !== 'string') {
      return res.status(400).json({ error: 'listingDescription must be a string or null.' });
    }
    const trimmed = (listingDescription || '').trim();
    if (trimmed.length > 1000) {
      return res.status(400).json({ error: 'listingDescription must be 1000 characters or fewer.' });
    }

    const { data: existingUnit } = await supabase.from('units').select('landlord_id, property_id').eq('id', unitId).maybeSingle();
    if (!existingUnit) return res.status(404).json({ error: 'Unit not found.' });
    const ownershipError = await checkLandlordOwnership(req, existingUnit.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, existingUnit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const { error } = await supabase
      .from('units')
      .update({ listing_description: trimmed || null })
      .eq('id', unitId);
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'unit_listing_description_changed', targetType: 'unit', targetId: unitId });

    return res.json({ message: 'Listing description updated.', listingDescription: trimmed || null });
  } catch (err) {
    logger.error('[unit] updateListingDescription error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update listing description.' });
  }
}

// ---------------------------------------------------------------------
// UPDATE DEPOSIT SETTINGS (DIRECT REQUEST): landlord sets whether this
// unit requires a deposit from a future tenant, and optionally what
// that expected amount is - shown on the vacant-unit listing so a
// prospective tenant knows before reaching out. Deliberately separate
// from tenants.deposit_amount (add-tenant-security-deposit.sql), which
// records what was ACTUALLY collected from a tenant already living
// there - this is only what's being ASKED of the next one.
// ---------------------------------------------------------------------
async function updateDepositSettings(req, res) {
  try {
    const { unitId } = req.params;
    const { requiresDeposit, depositAmountExpected } = req.body;

    if (typeof requiresDeposit !== 'boolean') {
      return res.status(400).json({ error: 'requiresDeposit must be true or false.' });
    }
    if (depositAmountExpected !== undefined && depositAmountExpected !== null) {
      const amt = Number(depositAmountExpected);
      if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'depositAmountExpected must be a positive number.' });
    }

    const { data: existingUnit } = await supabase.from('units').select('landlord_id, property_id').eq('id', unitId).maybeSingle();
    if (!existingUnit) return res.status(404).json({ error: 'Unit not found.' });
    const ownershipError = await checkLandlordOwnership(req, existingUnit.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, existingUnit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const { error } = await supabase
      .from('units')
      .update({
        requires_deposit: requiresDeposit,
        deposit_amount_expected: requiresDeposit ? (depositAmountExpected ?? null) : null,
      })
      .eq('id', unitId);
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'unit_deposit_setting_changed', targetType: 'unit', targetId: unitId, metadata: { requiresDeposit, depositAmountExpected } });

    return res.json({ message: 'Deposit setting saved.', requiresDeposit, depositAmountExpected: requiresDeposit ? (depositAmountExpected ?? null) : null });
  } catch (err) {
    logger.error('[unit] updateDepositSettings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update deposit setting.' });
  }
}

// ---------------------------------------------------------------------
// BULK DEPOSIT SETTINGS (direct request: "Landlord Bulk Deposit
// Assignment" - deposits were only settable one unit at a time by
// opening each unit individually. Same shape/reasoning as
// bulkUpdateDueDate/bulkUpdateRent above: a scope selector lets the
// caller apply one deposit rule to either their entire portfolio in
// one go ("all units") or a hand-picked set of units ("selected
// units"), instead of repeating the single-unit PATCH per unit.
//
// Scope is deliberately landlord-portfolio-wide for "all" (not just
// one property) per the spec ("across the landlord's entire
// portfolio in one go") - optionally narrowed to one property via
// propertyId, same as bulkUpdateDueDate supports. "selected" takes
// an explicit unitIds array (multi-select) and is NOT restricted to
// a single property, so a landlord can pick units spanning several
// properties in one action.
// ---------------------------------------------------------------------
async function bulkUpdateDepositSettings(req, res) {
  try {
    const { scope, propertyId, unitIds, requiresDeposit, depositAmountExpected } = req.body;

    if (!['all', 'selected'].includes(scope)) {
      return res.status(400).json({ error: "scope must be 'all' or 'selected'." });
    }
    if (typeof requiresDeposit !== 'boolean') {
      return res.status(400).json({ error: 'requiresDeposit must be true or false.' });
    }
    if (depositAmountExpected !== undefined && depositAmountExpected !== null) {
      const amt = Number(depositAmountExpected);
      if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'depositAmountExpected must be a positive number.' });
    }
    if (scope === 'selected' && (!Array.isArray(unitIds) || unitIds.length === 0)) {
      return res.status(400).json({ error: 'unitIds is required when scope is "selected".' });
    }

    const landlordId = effectiveLandlordId(req);
    const isManager = req.user.role === 'manager';
    const assignedPropertyIds = isManager ? await getManagerAssignedPropertyIds(req.user.id) : [];
    if (propertyId && isManager && !assignedPropertyIds.includes(propertyId)) {
      return res.status(403).json({ error: 'You do not manage this property.' });
    }

    let unitsQuery = supabase.from('units').select('id, unit_name, property_id, requires_deposit, deposit_amount_expected').eq('landlord_id', landlordId);
    if (scope === 'selected') {
      unitsQuery = unitsQuery.in('id', unitIds);
    } else if (propertyId) {
      unitsQuery = unitsQuery.eq('property_id', propertyId);
    } else if (isManager) {
      if (assignedPropertyIds.length === 0) return res.json({ message: 'No units to update.', updated: 0, skipped: 0 });
      unitsQuery = unitsQuery.in('property_id', assignedPropertyIds);
    }
    const { data: units, error: unitsErr } = await unitsQuery;
    if (unitsErr) throw unitsErr;
    if (!units || units.length === 0) {
      return res.json({ message: 'No units to update.', updated: 0, skipped: 0 });
    }
    if (scope === 'selected') {
      // Every requested id must actually belong to this landlord (and,
      // for a manager, to a property they're assigned to) - otherwise a
      // caller could smuggle in a unit that isn't theirs by id.
      const foundIds = new Set(units.map((u) => u.id));
      const missing = unitIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        return res.status(400).json({ error: 'One or more selected units were not found in your portfolio.' });
      }
      if (isManager) {
        const disallowed = units.some((u) => !assignedPropertyIds.includes(u.property_id));
        if (disallowed) return res.status(403).json({ error: 'You do not manage one or more of the selected units.' });
      }
    }

    const resolvedAmount = requiresDeposit ? (depositAmountExpected ?? null) : null;
    let updated = 0;
    let skipped = 0;
    // Units already matching the target setting are skipped rather
    // than re-written, same "no-op units don't count as updated"
    // behavior as bulkUpdateDueDate.
    const unitsToUpdate = units.filter((u) => {
      const alreadySet = !!u.requires_deposit === !!requiresDeposit
        && (!requiresDeposit || Number(u.deposit_amount_expected ?? null) === Number(resolvedAmount ?? null) || (u.deposit_amount_expected == null && resolvedAmount == null));
      if (alreadySet) { skipped += 1; return false; }
      return true;
    });

    await runInBatches(
      unitsToUpdate,
      async (unit) => {
        const { error: updateError } = await supabase
          .from('units')
          .update({ requires_deposit: requiresDeposit, deposit_amount_expected: resolvedAmount })
          .eq('id', unit.id);
        if (updateError) throw updateError;
        updated += 1;
      },
      {
        concurrency: 15,
        onError: (err, unit) => {
          logger.error(`[unit] bulkUpdateDepositSettings: failed for unit ${unit.id}:`, err.message);
          captureException(err);
          skipped += 1;
        },
      }
    );

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'bulk_deposit_setting_changed',
      targetType: scope === 'selected' ? 'unit' : 'property',
      targetId: scope === 'selected' ? null : (propertyId || null),
      metadata: { scope, updated, skipped, requiresDeposit, depositAmountExpected: resolvedAmount, unitIds: scope === 'selected' ? unitIds : undefined },
    });

    return res.json({
      message: requiresDeposit
        ? `Deposit requirement set for ${updated} unit${updated === 1 ? '' : 's'}${skipped ? ` (${skipped} already matched or skipped)` : ''}.`
        : `Deposit requirement cleared for ${updated} unit${updated === 1 ? '' : 's'}${skipped ? ` (${skipped} already matched or skipped)` : ''}.`,
      updated,
      skipped,
    });
  } catch (err) {
    logger.error('[unit] bulkUpdateDepositSettings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to bulk update deposit settings.' });
  }
}

module.exports = {
  createUnit,
  bulkCreateUnits,
  listUnits,
  getUnit,
  updateRent,
  bulkUpdateRent,
  applyScheduledRentChanges,
  listPendingRentChanges,
  updateDueDate,
  bulkUpdateDueDate,
  updateUnitStatus,
  verifyUnit,
  removeUnit,
  addExtraCharge,
  updatePaymentOverride,
  updatePublicListing,
  updateListingStatus,
  updateListingDescription,
  updateDepositSettings,
  bulkUpdateDepositSettings,
};
