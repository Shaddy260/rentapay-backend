// src/middleware/auth.middleware.js
//
// Issues and verifies JWTs, and enforces the Role Based Access Control
// table in blueprint 14.1 (admin / landlord / tenant).

const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(payload) {
  // payload should be { id, role } where role is 'admin' | 'landlord' | 'tenant' | 'manager'
  // 'manager' tokens additionally carry { landlordId } - the id of the
  // landlord who added them - since a manager's own id is NOT a
  // landlords.id and must never be substituted for one.
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Returns the landlord_id a request should be scoped to, regardless of
 * whether the caller is the landlord themself or a property manager
 * acting on that landlord's behalf. Use this everywhere a controller
 * used to do `const landlordId = req.user.id`.
 */
function effectiveLandlordId(req) {
  if (req.user.role === 'manager') return req.user.landlordId;
  return req.user.id;
}

// FIX ("deleted/revoked user stays logged in until their token
// naturally expires"): JWTs are stateless by design, so simply
// verifying the signature (as this used to do) has no way of knowing
// an admin deleted the landlord, or a landlord removed a manager or
// tenant, five minutes ago. This does one small lookup per request to
// confirm the account behind the token is still real and still
// active, and immediately rejects with a clear, specific message the
// frontend can show ("You've been logged out...") and use as a
// trigger to clear the stored token and bounce to the login screen.
//
// Fails OPEN (lets the request through) on an unexpected DB/network
// error rather than locking every single user out during a brief
// outage - it only fails CLOSED when the account is definitively
// gone or explicitly deactivated.
async function isAccountStillValid(user) {
  try {
    if (user.role === 'admin') return { valid: true };

    if (user.role === 'landlord') {
      const { data, error } = await supabase.from('landlords').select('id').eq('id', user.id).maybeSingle();
      if (error) return { valid: true }; // fail open on transient errors
      if (!data) return { valid: false, message: 'Your landlord account has been removed. You have been logged out.' };
      return { valid: true };
    }

    if (user.role === 'manager') {
      const { data, error } = await supabase.from('property_managers').select('id, is_active').eq('id', user.id).maybeSingle();
      if (error) return { valid: true };
      if (!data || data.is_active === false) {
        return { valid: false, message: 'Your access to this account has been removed. You have been logged out.' };
      }
      // The landlord who owns this manager must also still exist.
      const { data: landlord, error: landlordErr } = await supabase.from('landlords').select('id').eq('id', user.landlordId).maybeSingle();
      if (landlordErr) return { valid: true };
      if (!landlord) return { valid: false, message: 'This account has been removed. You have been logged out.' };
      return { valid: true };
    }

    if (user.role === 'tenant') {
      const { data, error } = await supabase.from('tenants').select('id, is_active').eq('id', user.id).maybeSingle();
      if (error) return { valid: true };
      if (!data || data.is_active === false) {
        return { valid: false, message: 'Your tenant access has been removed. You have been logged out.' };
      }
      return { valid: true };
    }

    if (user.role === 'scout') {
      const { data, error } = await supabase.from('scouts').select('id, is_active').eq('id', user.id).maybeSingle();
      if (error) return { valid: true };
      if (!data || data.is_active === false) {
        return { valid: false, message: 'Your Scout account has been deactivated. You have been logged out.' };
      }
      return { valid: true };
    }

    return { valid: true };
  } catch (err) {
    return { valid: true }; // fail open - never let an unexpected bug lock everyone out
  }
}

// PERFORMANCE FIX: verifyToken runs on essentially every single
// request in the app (every dashboard load, every list, every click)
// and used to do TWO uncached DB round-trips every single time - one
// to check platform-wide lockdown, one to re-verify the account still
// exists. That's fine at 1 user, but it's exactly the kind of thing
// that makes the app feel like it "takes too long to load" and gets
// much worse as more people use it at once, since every one of them
// is independently hammering the same two tables on every click.
//
// Both checks are cached in memory for a few seconds. Lockdown status
// changes rarely and doesn't need to be instantaneous - a few seconds
// of staleness is an acceptable trade for cutting a DB round-trip off
// of every request. Same for "does this account still exist" - a
// revoked user gets logged out within LOCKDOWN_CACHE_TTL_MS
// regardless, just not on the literal next millisecond after an admin
// clicks delete.
const LOCKDOWN_CACHE_TTL_MS = 120_000;
const ACCOUNT_CACHE_TTL_MS = 120_000;
let lockdownCache = { value: null, expiresAt: 0 };
const accountValidCache = new Map(); // key: `${role}:${id}` -> { value, expiresAt }

async function getLockdownStatus() {
  if (Date.now() < lockdownCache.expiresAt) return lockdownCache.value;
  try {
    const { data: settings } = await supabase.from('platform_settings').select('is_locked_down, lockdown_reason').eq('id', 1).maybeSingle();
    lockdownCache = { value: settings || null, expiresAt: Date.now() + LOCKDOWN_CACHE_TTL_MS };
    return lockdownCache.value;
  } catch (lockdownErr) {
    // fail open - a transient DB error shouldn't lock everyone out
    return null;
  }
}

async function isAccountStillValidCached(user) {
  const key = `${user.role}:${user.id}`;
  const cached = accountValidCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const status = await isAccountStillValid(user);
  accountValidCache.set(key, { value: status, expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS });
  return status;
}

async function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, role }

    // FIX ("lockdown should block EVERYONE already logged in too, not
    // just new login attempts"): emergencyLockdown previously only
    // stopped fresh logins - anyone with a still-valid token (landlord,
    // manager, caretaker, or tenant) kept working normally throughout
    // a "lockdown." Admin is exempt, same as at login, so there's
    // always a way to lift the lockdown.
    if (decoded.role !== 'admin') {
      const settings = await getLockdownStatus();
      if (settings?.is_locked_down) {
        return res.status(503).json({
          error: settings.lockdown_reason || 'The platform is temporarily paused for technical maintenance.',
          lockedDown: true,
        });
      }
    }

    const status = await isAccountStillValidCached(decoded);
    if (!status.valid) {
      return res.status(401).json({ error: status.message, accountRevoked: true });
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

/**
 * Restricts a route to specific roles.
 * Usage: requireRole('admin'), requireRole('admin', 'landlord')
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to access this resource.' });
    }
    next();
  };
}

/**
 * Ensures a landlord can only act on their own data (tenants/units they own).
 * Expects req.params.landlordId OR a resource already loaded onto req
 * with a landlord_id field to compare against req.user.id.
 * Admins bypass this check entirely (blueprint 14.1: admin sees everything).
 */
function requireOwnLandlordData(req, res, next) {
  if (req.user.role === 'admin') return next();

  if (req.user.role !== 'landlord' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Only landlords, property managers, or admins may access this resource.' });
  }

  const targetLandlordId = req.params.landlordId || req.body.landlordId;
  const ownLandlordId = effectiveLandlordId(req);
  if (targetLandlordId && targetLandlordId !== ownLandlordId) {
    return res.status(403).json({ error: 'You can only access your own data.' });
  }

  next();
}

/**
 * Restricts a route to the landlord themself (or admin) - used for the
 * handful of actions a property manager must never be able to do, e.g.
 * adding/removing other managers, subscription & billing changes.
 * Give a clear, specific reason so the frontend can show it as-is.
 */
function requireLandlordOnly(reason) {
  return (req, res, next) => {
    if (req.user.role === 'admin' || req.user.role === 'landlord') return next();
    return res.status(403).json({
      error: reason || 'This action is restricted to the landlord and is not available to property managers.',
      landlordOnly: true,
    });
  };
}

/**
 * For routes scoped to a single property (or a unit that belongs to
 * one): landlords and admins always pass. A manager passes only if
 * they have an active assignment to that property - otherwise a
 * clear "not authorized for this property" message is returned rather
 * than a generic 403, so the frontend can show it inline instead of
 * hiding the property entirely (the landlord wants managers to still
 * SEE all properties in lists, just be blocked from opening ones they
 * aren't assigned to).
 *
 * getPropertyId(req) must return the property_id to check.
 */
function requirePropertyAccess(getPropertyId) {
  return async (req, res, next) => {
    if (req.user.role === 'admin' || req.user.role === 'landlord') return next();
    if (req.user.role !== 'manager') {
      return res.status(403).json({ error: 'You do not have permission to access this resource.' });
    }

    try {
      const propertyId = await getPropertyId(req);
      if (!propertyId) return next(); // no property scoping applicable (e.g. ungrouped units) - allow through

      const supabase = require('../config/supabase');
      const { data: assignment } = await supabase
        .from('property_manager_assignments')
        .select('id')
        .eq('property_manager_id', req.user.id)
        .eq('property_id', propertyId)
        .maybeSingle();

      if (!assignment) {
        return res.status(403).json({
          error: 'You have not been given access to manage this property. Contact the landlord if you believe this is a mistake.',
          notAssigned: true,
        });
      }

      next();
    } catch (err) {
      console.error('[auth] requirePropertyAccess error:', err.message);
      return res.status(500).json({ error: 'Failed to verify property access.' });
    }
  };
}

/**
 * Like verifyToken, but doesn't reject the request if there's no token
 * or it's invalid - just leaves req.user unset. Used for endpoints
 * that should work for both logged-in users and anonymous visitors,
 * e.g. the pre-login Help form (blueprint 15: "help before logging in").
 */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.split(' ')[1];
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      // ignore - treat as anonymous
    }
  }
  next();
}

/**
 * Returns the list of property IDs a given property manager/caretaker
 * has actually been assigned to. Centralized here (rather than
 * duplicated in dashboard.controller.js and unit.controller.js) so
 * "which properties can this manager touch" is answered exactly the
 * same way everywhere - this is the fix for the bug where assigning a
 * manager to a SINGLE specific property left them unable to see
 * anything (each place that needed this list was computing it
 * slightly differently, or not scoping to it at all), while assigning
 * "all properties" happened to paper over the mismatch.
 */
async function getManagerAssignedPropertyIds(managerId) {
  const { data, error } = await supabase
    .from('property_manager_assignments')
    .select('property_id')
    .eq('property_manager_id', managerId);
  if (error) throw error;
  return (data || []).map((a) => a.property_id);
}

/**
 * Restricts a route away from caretaker-level property managers, while
 * still allowing full property managers, landlords, and admins.
 * A caretaker is the same login/table as a property manager
 * (property_managers, role='manager'), just flagged role_level =
 * 'caretaker' - a lighter-weight, on-the-ground contact who shouldn't
 * be able to delete tenants, transfer tenants between
 * units, or add/remove units/extra charges.
 */
function requireNotCaretaker(reason) {
  return (req, res, next) => {
    if (req.user.role === 'manager' && req.user.roleLevel === 'caretaker') {
      return res.status(403).json({
        error: reason || 'This action is not available to caretaker accounts. Contact the landlord or property manager.',
        caretakerRestricted: true,
      });
    }
    next();
  };
}

/**
 * Ownership check for controllers that load a record themselves (rather
 * than going through requirePropertyAccess at the route level). Returns
 * null if the caller is allowed to act on this record, or a
 * { statusCode, error } object the controller should return immediately.
 *
 * Added per the apartment-isolation audit - several single-record
 * controller functions (unit status/delete/extra-charges, tenant
 * balance lookups, etc.) were loading a record by id with NO check that
 * it belonged to the caller at all. This centralizes the exact check
 * already used correctly elsewhere (tenant.controller.js's
 * getTenant/editTenantDetails, unit.controller.js's getUnit) so new
 * code can't accidentally skip it, and existing gaps can be closed with
 * a one-line call instead of hand-rolled (and inconsistently-correct)
 * boolean logic.
 */
async function checkLandlordOwnership(req, recordLandlordId) {
  if (req.user.role === 'admin') return null;
  if (recordLandlordId !== effectiveLandlordId(req)) {
    return { statusCode: 403, error: 'You do not manage this record.' };
  }
  return null;
}

/**
 * Companion to checkLandlordOwnership: on top of "does this record
 * belong to the right landlord", also enforces "if the caller is a
 * manager restricted to specific properties, is this record in one of
 * them". No-op for landlords/admins, and for managers with no
 * restriction (assignedPropertyIds.length === 0, i.e. "all properties").
 * propertyId may be null/undefined (e.g. an ungrouped unit) - always
 * allowed through, same convention as requirePropertyAccess.
 */
async function checkManagerPropertyAccess(req, propertyId) {
  if (req.user.role !== 'manager' || !propertyId) return null;
  const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
  if (assignedPropertyIds.length > 0 && !assignedPropertyIds.includes(propertyId)) {
    return {
      statusCode: 403,
      error: 'You have not been given access to manage this property. Contact the landlord if you believe this is a mistake.',
      notAssigned: true,
    };
  }
  return null;
}

module.exports = {
  signToken,
  verifyToken,
  optionalAuth,
  requireRole,
  requireOwnLandlordData,
  requireLandlordOnly,
  requirePropertyAccess,
  requireNotCaretaker,
  effectiveLandlordId,
  getManagerAssignedPropertyIds,
  checkLandlordOwnership,
  checkManagerPropertyAccess,
};
