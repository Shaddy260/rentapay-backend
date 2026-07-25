// src/utils/emailUniqueness.js
//
// Mirrors phoneUniqueness.js, but for email. This matters more than
// it used to now that tenant reputation (reputation.service.js) is
// keyed by email - if two DIFFERENT people could hold an ACTIVE
// tenant account on the same email at the same time, their ratings
// would blend into one shared reputation, which is exactly the
// "shared family email / typo" edge case flagged in the reputation
// notes. Enforcing the same one-active-account-per-email rule used
// for phone closes that gap for the active-account path; a genuine
// same-email collision between two truly different tenants (one
// archived, one newly active) is still possible and is the case a
// "this isn't me" dispute flag would need to cover separately.
//
// Same exception as phone: an ARCHIVED tenant's email is free to
// reuse under a new (or the same) landlord - only an ACTIVE tenant
// elsewhere blocks it.

const supabase = require('../config/supabase');

/**
 * @param {string} email - already validated as a plausible email shape
 * @param {'landlord'|'manager'|'tenant'|'scout'} forRole
 * @returns {Promise<string|null>} a user-facing error message, or null if free to use.
 */
async function findEmailConflict(email, forRole) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;

  const [{ data: landlord }, { data: manager }, { data: activeTenant }, { data: scout }] = await Promise.all([
    supabase.from('landlords').select('id').ilike('email', normalized).maybeSingle(),
    supabase.from('property_managers').select('id').ilike('email', normalized).maybeSingle(),
    supabase.from('tenants').select('id, landlord_id, is_active').ilike('email', normalized).eq('is_active', true).maybeSingle(),
    supabase.from('scouts').select('id').ilike('email', normalized).maybeSingle(),
  ]);

  if (landlord) {
    return forRole === 'landlord'
      ? 'An account with this email address already exists.'
      : 'This email address is already registered to a landlord account. Please use a different email.';
  }

  if (manager) {
    return forRole === 'manager'
      ? 'A property manager with this email address already exists.'
      : 'This email address is already registered to a property manager/caretaker account. Please use a different email.';
  }

  if (activeTenant) {
    if (forRole === 'tenant') {
      return 'This email address is already registered to an active tenant account. Ask them to use a different email, or have their current landlord remove/archive them first.';
    }
    return 'This email address is already registered to a tenant account. Please use a different email.';
  }

  if (scout) {
    return forRole === 'scout'
      ? 'A Scout account with this email address already exists.'
      : "This email address is already registered to a RentaPay Scout account. Please use a different email.";
  }

  return null;
}

module.exports = { findEmailConflict };
