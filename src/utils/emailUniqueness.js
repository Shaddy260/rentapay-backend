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
// elsewhere blocks it. The same now applies to a removed (is_active =
// false) property manager/caretaker's email.

const supabase = require('../config/supabase');

/**
 * @param {string} email - already validated as a plausible email shape
 * @param {'landlord'|'manager'|'tenant'|'brand_ambassador'} forRole
 * @returns {Promise<string|null>} a user-facing error message, or null if free to use.
 */
async function findEmailConflict(email, forRole) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;

  const [{ data: landlord }, { data: activeManager }, { data: activeTenant }, { data: activeBa }, { data: activeGeneralManager }] = await Promise.all([
    supabase.from('landlords').select('id').ilike('email', normalized).maybeSingle(),
    // ARCHIVE FIX: same reasoning as phoneUniqueness.js - without
    // is_active here, an archived manager/caretaker's email blocked
    // that email from ever being reused for a manager/caretaker
    // account again, anywhere.
    supabase.from('property_managers').select('id, is_active').ilike('email', normalized).eq('is_active', true).maybeSingle(),
    supabase.from('tenants').select('id, landlord_id, is_active').ilike('email', normalized).eq('is_active', true).maybeSingle(),
    // BA onboarding (build spec Phase 1/2): global uniqueness across
    // every role, excluding 'rejected' BA rows - mirrors the partial
    // unique index on brand_ambassadors(lower(email)) WHERE status <> 'rejected'.
    supabase.from('brand_ambassadors').select('id, status').ilike('email', normalized).neq('status', 'rejected').maybeSingle(),
    // General Manager accounts (admin-provisioned only - see
    // 2026-08-general-manager-role.sql).
    // Excludes rejected applications, mirroring the partial unique
    // index on general_managers(lower(email)) WHERE status <>
    // 'rejected' - see 2026-08-general-manager-onboarding-approval.sql.
    supabase.from('general_managers').select('id, status').ilike('email', normalized).neq('status', 'rejected').maybeSingle(),
  ]);

  // PRIVACY FIX: see phoneUniqueness.js - when forRole is
  // 'brand_ambassador' we never reveal which other role a conflicting
  // email belongs to. Every branch collapses to the same generic
  // message in that case; other roles' existing role-specific
  // messages are unchanged.
  const GENERIC_BA_CONFLICT = 'This email address is already in use. Please use a different email.';

  if (landlord) {
    if (forRole === 'brand_ambassador') return GENERIC_BA_CONFLICT;
    return forRole === 'landlord'
      ? 'An account with this email address already exists.'
      : 'This email address is already registered to a landlord account. Please use a different email.';
  }

  if (activeManager) {
    if (forRole === 'brand_ambassador') return GENERIC_BA_CONFLICT;
    return forRole === 'manager'
      ? 'A property manager with this email address already exists.'
      : 'This email address is already registered to a property manager/caretaker account. Please use a different email.';
  }

  if (activeTenant) {
    if (forRole === 'brand_ambassador') return GENERIC_BA_CONFLICT;
    if (forRole === 'tenant') {
      return 'This email address is already registered to an active tenant account. Ask them to use a different email, or have their current landlord remove/archive them first.';
    }
    return 'This email address is already registered to a tenant account. Please use a different email.';
  }

  if (activeBa) {
    return forRole === 'brand_ambassador'
      ? GENERIC_BA_CONFLICT
      : 'This email address is already registered to a Brand Ambassador account. Please use a different email.';
  }

  return null;
}

module.exports = { findEmailConflict };
