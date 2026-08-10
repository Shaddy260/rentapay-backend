// src/utils/phoneUniqueness.js
//
// "No number should open more than one user account" - a phone number
// already used for a landlord/manager/tenant account must be
// rejected when someone tries to register a DIFFERENT kind of account
// (or a second account of the same kind) with it - with two deliberate
// exceptions: a tenant number can be reused under a new landlord once
// their old landlord has archived them (tenants.is_active = false),
// and likewise a manager/caretaker number can be reused once they've
// been removed by their previous landlord (property_managers.is_active
// = false). An active tenant/manager elsewhere is NOT reusable - the
// new landlord gets a clear error telling them to ask the person to
// use another number or have their previous landlord remove/archive
// them first.
//
// Called from registerLandlord (auth.controller.js), addManager
// (propertyManager.controller.js), and addTenant (tenant.controller.js)
// - one shared place so the three "already used elsewhere" checks
// can't drift out of sync with each other.

const supabase = require('../config/supabase');

/**
 * @param {string} phone - already normalized (2547XXXXXXXX shape)
 * @param {'landlord'|'manager'|'tenant'|'brand_ambassador'} forRole - the role being registered
 * @returns {Promise<string|null>} a user-facing error message if the
 *   phone can't be used, or null if it's free to use.
 */
async function findPhoneConflict(phone, forRole) {
  const [{ data: landlord }, { data: activeManager }, { data: activeTenant }, { data: activeBa }] = await Promise.all([
    supabase.from('landlords').select('id').eq('phone', phone).maybeSingle(),
    // ARCHIVE FIX: this used to have no is_active filter at all, so a
    // manager/caretaker archived (removed) by one landlord permanently
    // blocked that same phone number from ever being used again by
    // anyone, anywhere - the exact "moved to another landlord, now
    // stuck" bug reported for managers/caretakers, and it also fought
    // with the DB-level unique index below unless that index is
    // scoped the same way. is_active=true here already filters out
    // archived rows, matching the tenant exception underneath.
    supabase.from('property_managers').select('id, is_active').eq('phone', phone).eq('is_active', true).maybeSingle(),
    supabase.from('tenants').select('id, landlord_id, is_active').eq('primary_phone', phone).eq('is_active', true).maybeSingle(),
    // BA onboarding (build spec Phase 1/2): global uniqueness across
    // every role, excluding 'rejected' BA rows so a rejected applicant
    // can cleanly re-apply later - mirrors the partial unique index
    // on brand_ambassadors.phone (WHERE status <> 'rejected').
    supabase.from('brand_ambassadors').select('id, status').eq('phone', phone).neq('status', 'rejected').maybeSingle(),
  ]);

  // PRIVACY FIX: when the account being registered is a Brand
  // Ambassador, never disclose WHICH other role a conflicting
  // phone number belongs to (landlord/manager/tenant/BA) - that
  // leaks account-role information about a stranger to whoever is
  // filling out the BA onboarding form. Every branch below collapses
  // to the same generic "already in use" message for forRole ===
  // 'brand_ambassador'. Other roles keep their existing role-specific
  // messages unchanged (relied on elsewhere/by existing tests).
  const GENERIC_BA_CONFLICT = 'This phone number is already in use. Please use a different number.';

  if (landlord) {
    if (forRole === 'brand_ambassador') return GENERIC_BA_CONFLICT;
    return forRole === 'landlord'
      ? 'An account with this phone number already exists.'
      : 'This phone number is already registered to a landlord account. Please use a different number.';
  }

  if (activeManager) {
    if (forRole === 'brand_ambassador') return GENERIC_BA_CONFLICT;
    return forRole === 'manager'
      ? 'A property manager with this phone number already exists.'
      : 'This phone number is already registered to a property manager/caretaker account. Please use a different number.';
  }

  if (activeTenant) {
    if (forRole === 'brand_ambassador') return GENERIC_BA_CONFLICT;
    if (forRole === 'tenant') {
      // The one deliberate exception: an ARCHIVED tenant's number is
      // free to reuse under a new landlord - is_active=true above
      // already filters those out, so reaching here means this
      // tenant is still active somewhere.
      return 'This phone number is already registered to an active tenant account. Ask them to use a different number, or have their current landlord remove/archive them first.';
    }
    return 'This phone number is already registered to a tenant account. Please use a different number.';
  }

  if (activeBa) {
    return forRole === 'brand_ambassador'
      ? GENERIC_BA_CONFLICT
      : 'This phone number is already registered to a Brand Ambassador account. Please use a different number.';
  }

  return null;
}

module.exports = { findPhoneConflict };
