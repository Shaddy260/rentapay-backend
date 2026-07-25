// src/utils/phoneUniqueness.js
//
// "No number should open more than one user account" - a phone number
// already used for a landlord/manager/tenant/scout account must be
// rejected when someone tries to register a DIFFERENT kind of account
// (or a second account of the same kind) with it - with one deliberate
// exception: a tenant number can be reused under a new landlord once
// their old landlord has archived them (tenants.is_active = false).
// An active tenant elsewhere is NOT reusable - the new landlord gets a
// clear error telling them to ask the tenant to use another number or
// have their previous landlord remove them first.
//
// Scout accounts used to be a SECOND deliberate exception (a phone
// could hold both a landlord/manager/tenant account and a Scout
// account, disambiguated at login by the dual-role account picker).
// That's been reversed: a Scout account must now be fully exclusive -
// a Scout can only be a Scout, never also a landlord/manager/tenant on
// the same number. So scouts are checked here like every other role,
// and registerScout (scout.controller.js) now calls this function too
// instead of only checking the scouts table against itself.
//
// Called from registerLandlord (auth.controller.js), addManager
// (propertyManager.controller.js), addTenant (tenant.controller.js),
// and registerScout (scout.controller.js) - one shared place so the
// four "already used elsewhere" checks can't drift out of sync with
// each other.

const supabase = require('../config/supabase');

/**
 * @param {string} phone - already normalized (2547XXXXXXXX shape)
 * @param {'landlord'|'manager'|'tenant'|'scout'} forRole - the role being registered
 * @returns {Promise<string|null>} a user-facing error message if the
 *   phone can't be used, or null if it's free to use.
 */
async function findPhoneConflict(phone, forRole) {
  const [{ data: landlord }, { data: manager }, { data: activeTenant }, { data: scout }] = await Promise.all([
    supabase.from('landlords').select('id').eq('phone', phone).maybeSingle(),
    supabase.from('property_managers').select('id').eq('phone', phone).maybeSingle(),
    supabase.from('tenants').select('id, landlord_id, is_active').eq('primary_phone', phone).eq('is_active', true).maybeSingle(),
    supabase.from('scouts').select('id').eq('phone', phone).maybeSingle(),
  ]);

  if (landlord) {
    return forRole === 'landlord'
      ? 'An account with this phone number already exists.'
      : 'This phone number is already registered to a landlord account. Please use a different number.';
  }

  if (manager) {
    return forRole === 'manager'
      ? 'A property manager with this phone number already exists.'
      : 'This phone number is already registered to a property manager/caretaker account. Please use a different number.';
  }

  if (activeTenant) {
    if (forRole === 'tenant') {
      // The one deliberate exception: an ARCHIVED tenant's number is
      // free to reuse under a new landlord - is_active=true above
      // already filters those out, so reaching here means this
      // tenant is still active somewhere.
      return 'This phone number is already registered to an active tenant account. Ask them to use a different number, or have their current landlord remove/archive them first.';
    }
    return 'This phone number is already registered to a tenant account. Please use a different number.';
  }

  if (scout) {
    return forRole === 'scout'
      ? 'A Scout account with this phone number already exists.'
      : 'This phone number is already registered to a RentaPay Scout account. A Scout account can\'t also be a landlord/manager/tenant account - please use a different number.';
  }

  return null;
}

module.exports = { findPhoneConflict };
