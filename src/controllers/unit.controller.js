// src/controllers/unit.controller.js
const { effectiveLandlordId, getManagerAssignedPropertyIds, checkLandlordOwnership, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
//
// Implements blueprint section 7 (Unit Management) and the Step 3/4
// of the Setup Wizard (3.2): creating units, extra charges, status
// transitions, and the actions listed in 7.3.

const supabase = require('../config/supabase');
const { generateUnitCode, regenerateUnitCode } = require('../utils/unitCode');
const { logActivity } = require('../services/activityLog.service');
const { blockIfSubscriptionExpired } = require('../utils/subscriptionGate');
const { notify } = require('../services/notify.service');
const templates = require('../services/notificationTemplates');
const { postSystemAnnouncement } = require('./announcement.controller');
const { notifyScoutsOfNewVacancy } = require('./scout.controller');
const { validatePositiveAmount } = require('../utils/validateAmount');
const { reconcileLandlordUnitLimits } = require('../utils/unitLimitEnforcement');
const scoutReferralService = require('../services/scoutReferral.service');

// ---------------------------------------------------------------------
// CREATE UNIT (Setup Wizard step 3/4, or "Add new units" anytime - 7.3)
// ---------------------------------------------------------------------
async function createUnit(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { unitName, unitType, rentAmount, dueDayOfMonth, extraCharges, propertyId } = req.body;

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
      .ilike('unit_name', trimmedUnitName)
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
    // can compute the SAME "next" payment code and only one insert can
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

    // Pass 2, item 3 - trigger point #1 also covers a brand-new unit,
    // since it's created directly as 'vacant' and would otherwise never
    // pass through updateUnitStatus's 'vacant' branch at all.
    await notifyScoutsOfNewVacancy({
      unitId: unit.id,
      unitName: unit.unit_name,
      propertyId: unit.property_id || null,
      landlordId: unit.landlord_id,
    });

    return res.status(201).json({ unit });
  } catch (err) {
    console.error('[unit] createUnit error:', err.message);
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

    // "Scout referral - [date]" badge (spec §7): active, non-placed
    // referrals for every unit in this list, fetched in one bulk query
    // rather than per-unit, same reasoning as tenantsByUnit above.
    const activeReferralsByUnit = await scoutReferralService.getActiveReferralsForUnits(unitIds);

    const unitsWithTenants = (units || []).map((u) => ({
      ...u,
      tenants: tenantsByUnit[u.id] || [],
      activeScoutReferral: activeReferralsByUnit[u.id] || null,
    }));

    return res.json({ units: unitsWithTenants });
  } catch (err) {
    console.error('[unit] listUnits error:', err.message);
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
    console.error('[unit] updateRent error:', err.message);
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
    const { propertyId, percentIncrease, flatNewAmount, effectiveOption, effectiveDate } = req.body;
    const landlordId = effectiveLandlordId(req);

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
    if (propertyId) {
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

    let updated = 0;
    let skipped = 0;
    for (const unit of units) {
      const currentAmount = Number(unit.rent_amount || 0);
      const newAmount = flatNewAmount != null
        ? Number(flatNewAmount)
        : Math.round(currentAmount * (1 + Number(percentIncrease) / 100));
      if (newAmount <= 0 || newAmount === currentAmount) {
        skipped += 1;
        continue;
      }
      try {
        await applyRentChangeToUnit(unit, { newRentAmount: newAmount, resolvedDate, isImmediate, actorRole: req.user.role, actorId: req.user.id, landlordId });
        updated += 1;
      } catch (err) {
        console.error(`[unit] bulkUpdateRent: failed for unit ${unit.id}:`, err.message);
        skipped += 1;
      }
    }

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
    console.error('[unit] bulkUpdateRent error:', err.message);
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
    console.error('[unit] applyScheduledRentChanges: failed to fetch due changes:', error.message);
    return;
  }

  for (const change of due || []) {
    try {
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
    } catch (err) {
      console.error(`[unit] applyScheduledRentChanges: failed to apply change ${change.id}:`, err.message);
    }
  }
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
    console.error('[unit] listPendingRentChanges error:', err.message);
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
    console.error('[unit] updateDueDate error:', err.message);
    return res.status(500).json({ error: 'Failed to update due date.' });
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
    const { data: existingUnit } = await supabase.from('units').select('is_frozen, landlord_id, property_id').eq('id', unitId).maybeSingle();
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
    // Scout placement credit (spec §5): this endpoint's own
    // 'occupied' transition (distinct from the ones in
    // tenant.controller.js that fire when a tenant is actually added/
    // restored/transferred) still needs the same auto-credit check -
    // e.g. a landlord manually flips a unit back to occupied outside
    // the normal add-tenant flow.
    if (status === 'occupied' && unit) {
      await scoutReferralService.creditPlacementIfEligible(unitId);
    }

    if (status === 'vacant' && unit) {
      await postSystemAnnouncement(unit.landlord_id, `Unit ${unit.unit_name} has been marked vacant and is ready for a new tenant.`, {
        propertyId: unit.property_id || null,
      });

      // Pass 2, item 3 - "live push" trigger point #1: alert every
      // Scout actively subscribed to this unit's county (minus any who
      // are blocked, or whose landlord has opted out of scout
      // visibility entirely - see notifyScoutsOfNewVacancy for the
      // exact rules, mirrored from getVacancies). Never blocks this
      // request if push fails.
      await notifyScoutsOfNewVacancy({
        unitId,
        unitName: unit.unit_name,
        propertyId: unit.property_id || null,
        landlordId: unit.landlord_id,
      });
    }

    return res.json({ message: `Unit marked as ${status}.` });
  } catch (err) {
    console.error('[unit] updateUnitStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to update unit status.' });
  }
}

// ---------------------------------------------------------------------
// VERIFY UNIT (spec §2: freshness) - landlord/manager/caretaker taps
// "Still vacant - confirm" to stamp last_verified_at, separate from
// updated_at so a scout can tell "confirmed still vacant" apart from
// "someone merely edited this record" (see sql/add-scout-referrals.sql
// for the fuller reasoning). Deliberately allowed on a unit in any
// status, not just 'vacant' - the button is expected to live on the
// unit's own row regardless of current status, and confirming
// freshness on an occupied/maintenance unit is harmless, just a no-op
// as far as the scout vacancy list is concerned (that list only ever
// shows vacant units anyway).
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
    console.error('[unit] verifyUnit error:', err.message);
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
    console.error('[unit] removeUnit error:', err.message);
    return res.status(500).json({ error: 'Failed to remove unit.' });
  }
}

// ---------------------------------------------------------------------
// ADD EXTRA CHARGE (water/garbage/security/electricity - blueprint 6.1, 7.3)
// ---------------------------------------------------------------------
async function addExtraCharge(req, res) {
  try {
    const { unitId } = req.params;
    const { name, amount, recurring = true } = req.body;

    if (!name || amount == null) {
      return res.status(400).json({ error: 'name and amount are required.' });
    }
    const validatedChargeAmount = validatePositiveAmount(amount, { allowZero: true });
    if (validatedChargeAmount === null) {
      return res.status(400).json({ error: 'amount must be a valid non-negative number.' });
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
    if (unit.is_frozen) {
      return res.status(400).json({ error: 'This unit is frozen because your current subscription covers fewer units than you have. Renew or upgrade your subscription to unlock it.' });
    }

    let updatedCharges = unit.extra_charges || [];

    if (recurring) {
      updatedCharges = [...updatedCharges, { name, amount: validatedChargeAmount, recurring: true }];
      const { error } = await supabase.from('units').update({ extra_charges: updatedCharges }).eq('id', unitId);
      if (error) throw error;
    } else {
      // One-time charge: billed exactly once, right now, directly onto
      // whoever currently occupies the unit - never written into the
      // unit's persistent extra_charges list, so nothing here can ever
      // repeat on a future month's bill.
      const { data: tenant } = await supabase.from('tenants').select('id, balance_due').eq('unit_id', unitId).eq('is_active', true).maybeSingle();
      if (!tenant) {
        return res.status(400).json({ error: 'This unit has no active tenant to bill a one-time charge to.' });
      }
      const newBalance = Math.round((Number(tenant.balance_due || 0) + validatedChargeAmount) * 100) / 100;
      const { error } = await supabase.from('tenants').update({ balance_due: newBalance }).eq('id', tenant.id);
      if (error) throw error;
    }

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'extra_charge_added', targetType: 'unit', targetId: unitId, metadata: { name, amount, recurring: !!recurring } });

    await postSystemAnnouncement(
      unit.landlord_id,
      `A new ${recurring ? '' : 'one-time '}charge "${name}" of KES ${Number(amount).toLocaleString()} has been added to Unit ${unit.unit_name}.`,
      { unitId, propertyId: unit.property_id || null }
    );

    return res.json({ message: recurring ? 'Recurring charge added.' : 'One-time charge billed.', extraCharges: updatedCharges });
  } catch (err) {
    console.error('[unit] addExtraCharge error:', err.message);
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

    const activeScoutReferral = await scoutReferralService.getActiveReferralForUnit(unitId);

    return res.json({
      unit: { ...unit, tenants: sanitizedTenants, activeScoutReferral },
      payments: payments || [],
      pendingRentChange: pendingRentChange || null,
    });
  } catch (err) {
    console.error('[unit] getUnit error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch unit.' });
  }
}

// ---------------------------------------------------------------------
// RENAME UNIT - previously there was no way to change unit_name after
// creation at all (it was write-once). Note: renaming does NOT change
// the unit's payment code (RPA-A1-001 etc stays fixed per blueprint
// 4.2 - "the code is fixed to the ROOM, not the tenant" - and by
// extension shouldn't silently change just because the display name
// did, since tenants/landlords may already be referencing the code).
// ---------------------------------------------------------------------
async function renameUnit(req, res) {
  try {
    const { unitId } = req.params;
    const { newUnitName } = req.body;
    const landlordId = effectiveLandlordId(req);

    if (!newUnitName || !newUnitName.trim()) {
      return res.status(400).json({ error: 'newUnitName is required.' });
    }

    const { data: unit, error: fetchError } = await supabase.from('units').select('landlord_id, unit_payment_code, is_frozen, property_id').eq('id', unitId).single();
    if (fetchError || !unit) return res.status(404).json({ error: 'Unit not found.' });
    if (unit.landlord_id !== landlordId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You do not own this unit.' });
    }
    const propertyAccessError = await checkManagerPropertyAccess(req, unit.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    if (unit.is_frozen) {
      return res.status(400).json({ error: 'This unit is frozen because your current subscription covers fewer units than you have. Renew or upgrade your subscription to unlock it.' });
    }

    const trimmedNewName = newUnitName.trim();
    const { data: nameClash } = await supabase
      .from('units')
      .select('id')
      .eq('landlord_id', landlordId)
      .ilike('unit_name', trimmedNewName)
      .neq('id', unitId)
      .maybeSingle();
    if (nameClash) {
      return res.status(409).json({ error: `A unit named "${trimmedNewName}" already exists.` });
    }

    // Renaming a unit changes its payment code too (blueprint 4.2's
    // RPA-[UnitName]-[Number] format), so tenants and M-Pesa STK
    // account references always reflect the current name. The
    // sequence number itself is preserved - see regenerateUnitCode.
    const newUnitPaymentCode = regenerateUnitCode(unit.unit_payment_code, trimmedNewName);

    const { error } = await supabase
      .from('units')
      .update({ unit_name: trimmedNewName, unit_payment_code: newUnitPaymentCode })
      .eq('id', unitId);
    if (error) throw error;

    logActivity({
      actorType: req.user.role,
      actorId: landlordId,
      action: 'unit_renamed',
      targetType: 'unit',
      targetId: unitId,
      metadata: { newUnitName, oldUnitPaymentCode: unit.unit_payment_code, newUnitPaymentCode },
    });

    return res.json({ message: 'Unit renamed.', unitPaymentCode: newUnitPaymentCode });
  } catch (err) {
    console.error('[unit] renameUnit error:', err.message);
    return res.status(500).json({ error: 'Failed to rename unit.' });
  }
}

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
    const { enabled, method, paybillNumber, accountNumber, tillNumber } = req.body;
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
    console.error('[unit] updatePaymentOverride error:', err.message);
    return res.status(500).json({ error: 'Failed to update payment override.' });
  }
}

module.exports = {
  createUnit,
  listUnits,
  getUnit,
  updateRent,
  bulkUpdateRent,
  applyScheduledRentChanges,
  listPendingRentChanges,
  updateDueDate,
  updateUnitStatus,
  verifyUnit,
  removeUnit,
  addExtraCharge,
  renameUnit,
  updatePaymentOverride,
};
