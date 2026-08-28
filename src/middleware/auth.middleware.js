// src/middleware/auth.middleware.js
//
// Issues and verifies JWTs, and enforces the Role Based Access Control
// table in blueprint 14.1 (admin / landlord / tenant).

const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { comparePassword } = require('../utils/password');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(payload) {
  // payload should be { id, role } where role is
  // 'admin' | 'landlord' | 'tenant' | 'manager' | 'brand_ambassador' | 'general_manager'
  // 'manager' tokens additionally carry { landlordId } - the id of the
  // landlord who added them - since a manager's own id is NOT a
  // landlords.id and must never be substituted for one.
  // 'general_manager' tokens carry no landlordId - a General Manager
  // is scoped platform-wide (see Section 5 of the sectioned spec), not
  // to any single landlord's data.
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

const DEVICE_TRUST_EXPIRES_IN = process.env.DEVICE_TRUST_EXPIRES_IN || '30d';

// "Remember this device" for 2FA (direct request: avoid typing a TOTP
// code on every login on the same phone that already proved it has
// the authenticator). This is a SEPARATE, narrowly-scoped JWT - never
// a stand-in for the real session token. It only ever proves "this
// browser already completed a TOTP challenge for this account
// recently", nothing else:
//   - `purpose: 'device_trust'` so verifyToken (below) refuses to
//     accept it as a Bearer session token even if someone tries -
//     without this, a leaked device-trust token would be a full
//     account takeover instead of just a 2FA skip.
//   - No role-shaped {id, role} payload, so it can't accidentally
//     satisfy requireRole() checks either.
//   - Short-ish expiry (30d default) and re-issued fresh each time it
//     is used, not indefinitely renewable off a single enrollment.
function signDeviceTrustToken({ accountType, accountId }) {
  return jwt.sign({ purpose: 'device_trust', accountType, accountId }, JWT_SECRET, {
    expiresIn: DEVICE_TRUST_EXPIRES_IN,
  });
}

// Returns { accountType, accountId } if the token is a valid,
// unexpired device-trust token for that exact account, else null.
// Never throws - callers treat a bad/missing token as "not trusted",
// not as an error worth surfacing to the user.
function verifyDeviceTrustToken(token, { accountType, accountId } = {}) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.purpose !== 'device_trust') return null;
    if (accountType && decoded.accountType !== accountType) return null;
    if (accountId && String(decoded.accountId) !== String(accountId)) return null;
    return { accountType: decoded.accountType, accountId: decoded.accountId };
  } catch {
    return null;
  }
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

    // A BA must be 'active' to keep working - 'suspended' blocks login
    // and new claim submissions (their already-qualified/paid history
    // stays intact and visible to admin, per the Money & Data
    // Integrity Rules - this check only governs whether the session
    // itself stays valid), and 'inactive' (offboarded) or 'rejected'
    // rows should never carry a working session either.
    if (user.role === 'brand_ambassador') {
      const { data, error } = await supabase.from('brand_ambassadors').select('id, status').eq('id', user.id).maybeSingle();
      if (error) return { valid: true };
      if (!data || data.status !== 'active') {
        return { valid: false, message: 'Your Brand Ambassador access is no longer active. You have been logged out.' };
      }
      return { valid: true };
    }

    // SECTION 3: same revoked-mid-session protection every other role
    // already gets - admin deactivating a General Manager takes effect
    // within ACCOUNT_CACHE_TTL_MS, not just on their next fresh login.
    if (user.role === 'general_manager') {
      const { data, error } = await supabase.from('general_managers').select('id, is_active').eq('id', user.id).maybeSingle();
      if (error) return { valid: true };
      if (!data || data.is_active === false) {
        return { valid: false, message: 'Your access to this account has been removed. You have been logged out.' };
      }
      return { valid: true };
    }

    return { valid: true };
  } catch (err) {
    // fail open - never let an unexpected bug lock everyone out - but
    // this check exists to catch revoked/deactivated accounts, so a
    // persistent failure here silently disables that entirely with
    // no other signal. Report it without changing the fail-open result.
    logger.error('[auth] account-validity check failed (failing open)', err);
    captureException(err);
    return { valid: true };
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
    // fail open - a transient DB error shouldn't lock everyone out -
    // but a persistent failure here means lockdown mode could never
    // actually engage when needed, with no other signal that it's broken.
    logger.error('[auth] getLockdownStatus check failed (failing open)', lockdownErr);
    captureException(lockdownErr);
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

// FEATURE (direct request: "they shouldn't be able to access anything
// at all" once a subscription lapses - the old per-endpoint checks
// left most of the app fully working). Same caching approach as
// isAccountStillValidCached above, but a separate check and a
// separate response shape: an expired subscription does NOT revoke
// the account or force a logout (accountRevoked would do that) - it
// blocks the request with subscriptionExpired: true so the frontend
// can route the person to the renewal screen instead, while keeping
// them logged in so they can actually pay. This is deliberately
// account-wide (the landlord's own row), matching how renewal itself
// works - there is one subscription per landlord account.
const SUBSCRIPTION_CACHE_TTL_MS = 60_000;
const subscriptionExpiredCache = new Map(); // key: landlordId -> { value, expiresAt }

async function isAccountSubscriptionExpiredCached(landlordId) {
  const cached = subscriptionExpiredCache.get(landlordId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  let expired = false;
  try {
    const { data } = await supabase.from('landlords').select('subscription_status').eq('id', landlordId).maybeSingle();
    expired = data?.subscription_status === 'expired';
  } catch (err) {
    logger.error('[auth] subscription-expiry check failed (failing open)', err);
    captureException(err);
  }
  subscriptionExpiredCache.set(landlordId, { value: expired, expiresAt: Date.now() + SUBSCRIPTION_CACHE_TTL_MS });
  return expired;
}

async function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // A device-trust token (see signDeviceTrustToken above) must never
    // work as a session token - it proves "2FA was solved recently on
    // this device", not "this is a valid logged-in session".
    if (decoded.purpose === 'device_trust') {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }
    req.user = decoded; // { id, role }

    // Tag every subsequent log line for this request with who's making
    // it, so an incident like "every failed action by landlord X" can
    // be filtered on userId/userRole instead of grepped from text.
    logger.updateContext({ userId: decoded.id, userRole: decoded.role });

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

    // Subscription hard-lock: landlord/manager/caretaker stay logged
    // in but every route except the subscription routes themselves
    // (renew, add-units, manual-payment, status) is blocked once the
    // account's subscription has lapsed. Skipped for tenants, admins,
    // and the subscription routes' own mount path (or renewing would
    // be impossible).
    if ((decoded.role === 'landlord' || decoded.role === 'manager') && !req.originalUrl.startsWith('/api/subscriptions')) {
      const landlordId = decoded.role === 'landlord' ? decoded.id : decoded.landlordId;
      if (landlordId) {
        const expired = await isAccountSubscriptionExpiredCached(landlordId);
        if (expired) {
          return res.status(403).json({
            error: 'Your RentaPay subscription has ended. Renew it to continue using RentaPay.',
            subscriptionExpired: true,
          });
        }
      }
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
 * SECTION 5 (General Manager spec) - "everything admin can see across
 * the platform ... with one specific exception": the financial
 * breakdown / profit section (total earned, commissions paid out,
 * operating expenses, net profit) stays admin-only, in full, at the
 * route level - not just hidden in the frontend. Mount this on any
 * route that returns those figures, alongside requireRole('admin',
 * 'general_manager'), so a General Manager gets a clean 403 and the
 * data never leaves the server for that role. Admin passes through
 * untouched.
 */
function blockGeneralManagerFinancial(req, res, next) {
  if (req.user && req.user.role === 'general_manager') {
    return res.status(403).json({ error: 'General Managers do not have access to platform financial or profit data.' });
  }
  next();
}

/**
 * SECTION 6 (General Manager spec) — Edit Scope, PIN Confirmation &
 * Mandatory Reason.
 *
 * Supersedes the old generalManagerReadOnly gate now that editing is
 * actually built. Mount this (in place of that old gate) on any
 * router opened up to 'general_manager' that now allows writes.
 * Admin passes straight through untouched - none of this applies
 * unless req.user.role is 'general_manager'.
 *
 * For a General Manager:
 *   - GET/HEAD requests always pass straight through - Section 5's
 *     visibility doesn't need confirming, only changes do.
 *   - Every other request must carry { operationsPin, reason } in the
 *     body. Per the spec: "The login password plays no role here -
 *     it's used only to log in (Section 3). Every edit action
 *     requires the Operations PIN (Section 4) to confirm it. Every
 *     PIN-confirmed action also requires the General Manager to type
 *     a mandatory reason ... the action cannot succeed without one."
 *   - The PIN is compared against this GM's own operations_pin_hash
 *     only (req.user.id) - a General Manager can only ever confirm
 *     actions with their OWN PIN, never anyone else's.
 *   - A GM who has somehow reached a protected route without ever
 *     completing Section 4's onboarding (operations_pin_hash still
 *     null) is blocked with a clear message rather than crashing on a
 *     null hash - this should be unreachable in practice since the
 *     frontend forces PIN setup before the dashboard loads, but it's
 *     checked defensively here too since this is a security gate.
 *
 * On success, the verified reason is stashed on req.pinConfirmedReason
 * so the controller (and, later, Section 7's automatic logging) can
 * record it without re-parsing the body or trusting an unverified
 * value.
 */
async function requireOperationsPinConfirmation(req, res, next) {
  if (!req.user || req.user.role !== 'general_manager') return next();
  if (req.method === 'GET' || req.method === 'HEAD') return next();

  try {
    const { operationsPin, reason } = req.body || {};
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!trimmedReason) {
      return res.status(400).json({ error: 'A reason is required to confirm this action.' });
    }
    if (!operationsPin) {
      return res.status(400).json({ error: 'Your Operations PIN is required to confirm this action.' });
    }

    const { data: manager, error } = await supabase
      .from('general_managers')
      .select('id, operations_pin_hash, is_active')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error || !manager) return res.status(404).json({ error: 'Account not found.' });
    if (!manager.is_active) return res.status(403).json({ error: 'This account has been deactivated.' });
    if (!manager.operations_pin_hash) {
      return res.status(409).json({ error: 'Set your Operations PIN in Settings before making changes.' });
    }

    const matches = await comparePassword(String(operationsPin), manager.operations_pin_hash);
    if (!matches) {
      return res.status(401).json({ error: 'Incorrect Operations PIN. Action was NOT performed.' });
    }

    req.pinConfirmedReason = trimmedReason;
    next();
  } catch (err) {
    logger.error('[auth] requireOperationsPinConfirmation error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to verify Operations PIN.' });
  }
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
      logger.error('[auth] requirePropertyAccess error', err);
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
      logger.updateContext({ userId: req.user.id, userRole: req.user.role });
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

/**
 * Restricts a route to Brand Ambassadors only (does NOT let admin
 * through, unlike requireLandlordOnly - admin has its own separate
 * BA-management endpoints, see Phase 2/5/6). Usage:
 * router.get('/ba/stats', verifyToken, requireRole('brand_ambassador'), ...)
 * is equivalent to this and can be used interchangeably; this named
 * helper exists to make BA-only routes greppable/self-documenting the
 * same way requireLandlordOnly is.
 */
function requireBrandAmbassador(req, res, next) {
  if (!req.user || req.user.role !== 'brand_ambassador') {
    return res.status(403).json({ error: 'This action is restricted to Brand Ambassador accounts.' });
  }
  next();
}

/**
 * A BA can only ever see their own data - enforced server-side, not
 * just hidden in the UI. Every BA-scoped controller
 * (listMyOnboardedLandlords, getBaStats, dashboard totals, referral
 * link, earnings statement) should derive the BA id from this helper,
 * never from a client-supplied id/param, mirroring effectiveLandlordId's
 * role above.
 */
function effectiveBaId(req) {
  return req.user.id;
}

/**
 * FEATURE (direct request) - per-General-Manager feature toggles set
 * by admin from GeneralManagersPanel.jsx (see
 * generalManager.controller.js's updateGmPermissions). Admin always
 * passes through untouched. A General Manager is blocked with a
 * clear message unless their own general_managers.<column> is true -
 * this runs for EVERY method (including GET), unlike
 * requireOperationsPinConfirmation, since some of these toggles gate
 * visibility itself (e.g. "can this GM even see the manual payments
 * queue"), not just the write actions on it.
 */
function requireGmPermission(column) {
  return async (req, res, next) => {
    if (!req.user || req.user.role !== 'general_manager') return next();
    try {
      const { data: manager, error } = await supabase
        .from('general_managers')
        .select(column)
        .eq('id', req.user.id)
        .maybeSingle();
      if (error) throw error;
      if (!manager || !manager[column]) {
        return res.status(403).json({ error: 'Your admin has not enabled this for your account.', permissionDenied: true });
      }
      next();
    } catch (err) {
      logger.error('[auth] requireGmPermission error:', err.message);
      captureException(err);
      return res.status(500).json({ error: 'Failed to verify permission.' });
    }
  };
}

module.exports = {
  signToken,
  signDeviceTrustToken,
  verifyDeviceTrustToken,
  verifyToken,
  optionalAuth,
  requireRole,
  requireOwnLandlordData,
  requireLandlordOnly,
  requirePropertyAccess,
  requireNotCaretaker,
  requireBrandAmbassador,
  blockGeneralManagerFinancial,
  requireOperationsPinConfirmation,
  requireGmPermission,
  effectiveLandlordId,
  effectiveBaId,
  getManagerAssignedPropertyIds,
  checkLandlordOwnership,
  checkManagerPropertyAccess,
};
