// src/utils/unitLimitEnforcement.js
//
// Shared logic for what happens to units/tenants when a landlord's
// (or a specific property's) subscribed unit count changes - called
// from both the landlord's own subscription renewal
// (payment.controller.js processSubscriptionPaymentCallback) and an
// admin manually editing a subscription (admin.controller.js
// editLandlordSubscription), so the two paths can't drift into
// different behaviour.
//
// Rules (direct product requirement):
//  - Reducing the unit count NEVER deletes a tenant. If a removed
//    unit had a tenant, that tenant goes to Archive (is_active=false,
//    left_at=now()) exactly like any other "remove tenant" action -
//    they stay fully visible/restorable, just no longer occupying a
//    unit.
//  - The removed unit itself is FROZEN (is_frozen=true), not deleted -
//    frozen units are greyed out / read-only in the UI, but keep
//    existing "in the background".
//  - When choosing which units to freeze, EMPTY units are always
//    freed up first. Only once there are no more empty units to
//    freeze does this reach into occupied ones (and archive their
//    tenant) - so a landlord who removes 2 units but has 3 vacant
//    ones loses zero tenants.
//  - Raising the unit count back up (renewal/upgrade) unfreezes
//    previously-frozen units automatically, most-recently-frozen
//    first back to least-recently. Unfreezing does NOT auto-restore
//    an archived tenant into the unit - the unit just becomes usable
//    (vacant) again; reassigning a tenant is a manual landlord action,
//    since auto-reactivating billing on a stale tenant without the
//    landlord's say-so would be its own kind of bug.
//
// Scope: pass either a landlordId (account-wide unit_limit, the
// legacy/pooled clock) or a propertyId (a property with its own
// independently-purchased unit_limit - see add-per-property-
// subscriptions.sql). Exactly one of the two should be set.

const supabase = require('../config/supabase');
const { logActivity } = require('../services/activityLog.service');

/**
 * @param {object} opts
 * @param {string} [opts.landlordId] - account-wide scope
 * @param {string} [opts.propertyId] - single-property scope
 * @param {number} opts.newLimit - the new unit_limit being applied
 * @param {string} opts.actorType - 'admin' | 'landlord' | 'system'
 * @param {string} [opts.actorId]
 * @param {string[]} [opts.excludePropertyIds] - only used with landlordId
 *   scope: properties that have their OWN independent unit_limit clock
 *   (see add-per-property-subscriptions.sql), so the pooled/legacy
 *   landlord-wide clock doesn't double-count their units.
 */
async function applyUnitLimitChange({ landlordId, propertyId, newLimit, actorType, actorId, excludePropertyIds }) {
  if (newLimit == null || newLimit < 0) return; // nothing to enforce

  let unitsQuery = supabase.from('units').select('id, status, is_frozen, frozen_at').order('frozen_at', { ascending: true, nullsFirst: true });
  if (propertyId) {
    unitsQuery = unitsQuery.eq('property_id', propertyId);
  } else {
    unitsQuery = unitsQuery.eq('landlord_id', landlordId);
    if (excludePropertyIds && excludePropertyIds.length) {
      // A unit with no property at all (never assigned to one) still
      // belongs to the pooled clock - only units that DO belong to one
      // of the excluded (independently-clocked) properties are left out.
      unitsQuery = unitsQuery.or(`property_id.is.null,property_id.not.in.(${excludePropertyIds.join(',')})`);
    }
  }

  const { data: units, error } = await unitsQuery;
  if (error) {
    console.error('[unitLimitEnforcement] failed to load units:', error.message);
    return;
  }

  const total = (units || []).length;
  const currentlyUnfrozen = (units || []).filter((u) => !u.is_frozen);
  const currentlyFrozen = (units || []).filter((u) => u.is_frozen);

  if (newLimit >= total) {
    // Increase (or exactly enough) - unfreeze up to however many
    // frozen units are needed to reach newLimit, oldest-frozen first
    // so units don't sit greyed out longer than necessary.
    const slotsToUnfreeze = Math.min(currentlyFrozen.length, newLimit - currentlyUnfrozen.length);
    if (slotsToUnfreeze > 0) {
      const idsToUnfreeze = currentlyFrozen.slice(0, slotsToUnfreeze).map((u) => u.id);
      await supabase.from('units').update({ is_frozen: false, frozen_at: null }).in('id', idsToUnfreeze);
      await logActivity({
        actorType,
        actorId,
        action: 'units_unfrozen',
        targetType: 'landlord',
        targetId: landlordId || null,
        metadata: { propertyId: propertyId || null, unfrozenUnitIds: idsToUnfreeze, newLimit },
      });
    }
    return;
  }

  // Decrease - need to freeze (currentlyUnfrozen.length - newLimit) units.
  const numberToFreeze = currentlyUnfrozen.length - newLimit;
  if (numberToFreeze <= 0) return; // already within budget (some units may already be frozen from before)

  // Empty units first (vacant/maintenance/notice_given with no active
  // tenant), occupied units only if we run out of empty ones.
  const empty = currentlyUnfrozen.filter((u) => u.status !== 'occupied');
  const occupied = currentlyUnfrozen.filter((u) => u.status === 'occupied');
  const toFreeze = [...empty, ...occupied].slice(0, numberToFreeze);

  if (!toFreeze.length) return;

  const toFreezeIds = toFreeze.map((u) => u.id);
  const occupiedToFreezeIds = toFreeze.filter((u) => u.status === 'occupied').map((u) => u.id);

  await supabase.from('units').update({ is_frozen: true, frozen_at: new Date().toISOString() }).in('id', toFreezeIds);

  if (occupiedToFreezeIds.length) {
    // Archive (never delete) the tenants in units that had to be frozen.
    const { data: affectedTenants } = await supabase
      .from('tenants')
      .select('id, unit_id')
      .in('unit_id', occupiedToFreezeIds)
      .eq('is_active', true);

    if (affectedTenants && affectedTenants.length) {
      const tenantIds = affectedTenants.map((t) => t.id);
      await supabase.from('tenants').update({ is_active: false, left_at: new Date().toISOString() }).in('id', tenantIds);
      await logActivity({
        actorType,
        actorId,
        action: 'tenants_archived_due_to_unit_downgrade',
        targetType: 'landlord',
        targetId: landlordId || null,
        metadata: { propertyId: propertyId || null, archivedTenantIds: tenantIds, newLimit },
      });
    }
  }

  await logActivity({
    actorType,
    actorId,
    action: 'units_frozen',
    targetType: 'landlord',
    targetId: landlordId || null,
    metadata: { propertyId: propertyId || null, frozenUnitIds: toFreezeIds, newLimit },
  });
}

// ---------------------------------------------------------------------
// FIX (direct request): "any edit made in SQL or the Supabase SQL
// editor should automatically affect that account no matter what -
// Supabase is the king here." Freezing/unfreezing units only ever
// used to happen as a side effect of going through the app's own
// renewal/admin-edit code paths (see applyUnitLimitChange above) - a
// unit_limit changed directly in the Supabase table editor or SQL
// editor just sat there with the is_frozen flags never recalculated,
// so the dashboard kept showing the OLD frozen/unfrozen state (and
// "Add unit" kept letting a landlord add units past whatever their
// real, current unit_limit says) until someone happened to trigger a
// real renewal.
//
// This re-derives the correct frozen/unfrozen state from whatever
// unit_limit values are in the database RIGHT NOW, every time it's
// called - so it's safe (and cheap) to call opportunistically on
// every dashboard load and before every unit creation, which makes
// a raw database edit take effect immediately without needing its
// own separate trigger/cron.
// ---------------------------------------------------------------------
async function reconcileLandlordUnitLimits(landlordId) {
  if (!landlordId) return;
  try {
    const [{ data: landlord }, { data: properties }] = await Promise.all([
      supabase.from('landlords').select('unit_limit').eq('id', landlordId).maybeSingle(),
      supabase.from('properties').select('id, unit_limit').eq('landlord_id', landlordId),
    ]);

    const ownClockPropertyIds = (properties || []).filter((p) => p.unit_limit != null).map((p) => p.id);

    // PERFORMANCE FIX (direct request: dashboard/login/navigation are
    // "taking so long to load"): the pooled landlord-wide reconcile and
    // each property's own reconcile touch completely disjoint sets of
    // units, so there's no reason to wait for one to finish before
    // starting the next - all of them fire together instead.
    const jobs = [];
    if (landlord?.unit_limit != null) {
      jobs.push(
        applyUnitLimitChange({
          landlordId,
          newLimit: landlord.unit_limit,
          actorType: 'system',
          excludePropertyIds: ownClockPropertyIds,
        })
      );
    }
    for (const property of properties || []) {
      if (property.unit_limit != null) {
        jobs.push(applyUnitLimitChange({ propertyId: property.id, newLimit: property.unit_limit, actorType: 'system' }));
      }
    }
    await Promise.all(jobs);
  } catch (err) {
    // Never let a reconciliation failure block the actual page load or
    // unit creation the caller is trying to do.
    console.error('[unitLimitEnforcement] reconcileLandlordUnitLimits failed (non-blocking):', err.message);
  }
}

module.exports = { applyUnitLimitChange, reconcileLandlordUnitLimits };
