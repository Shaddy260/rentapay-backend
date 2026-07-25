// src/services/activityLog.service.js
//
// Central logging used by every controller that performs a sensitive
// action (waiving interest, revoking notices, editing balances, etc).
// Blueprint 14.2: "Every action logged: who, what, when, which IP"

const supabase = require('../config/supabase');

// Several call sites pass the hardcoded string 'super-admin' as actorId
// (the admin JWT's id claim, since there's no real admin row/UUID for
// the single hardcoded super-admin account) - activity_logs.actor_id
// is a uuid column, so inserting that literal string always failed at
// the database level with "invalid input syntax for type uuid".
// Guarded here, once, for every call site: a non-UUID actorId is
// stored as null instead of being sent to Postgres, so the log row
// still gets written (who = admin, what, when, IP) - it just can't
// attribute it to a specific admin UUID that doesn't exist.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeActorId(id) {
  return UUID_RE.test(id || '') ? id : null;
}

/**
 * @param {object} params
 * @param {'admin'|'landlord'|'tenant'|'system'} params.actorType
 * @param {string|null} params.actorId
 * @param {string} params.action - short machine-readable action name
 * @param {string} [params.targetType]
 * @param {string} [params.targetId]
 * @param {string} [params.reason]
 * @param {string} [params.ipAddress]
 * @param {object} [params.metadata]
 */
async function logActivity({ actorType, actorId = null, action, targetType, targetId, reason, ipAddress, metadata = {} }) {
  // PERFORMANCE FIX (direct request: "it takes too long to load/
  // navigate in the portals"): logActivity() writes an audit row and
  // was `await`ed before responding on ~60 write actions across the
  // app (add a tenant, record a payment, edit a unit, update
  // settings, etc.) - every one of those actions was paying for a
  // full extra database round-trip that the person never needed to
  // wait on, since nothing in the response depends on the log write
  // succeeding. Wrapped in try/catch (not just checking the Supabase
  // {error} field) so this function can never reject, which makes it
  // safe for every call site to fire it without awaiting (see the
  // controllers - the log still always happens, just after the
  // response has already gone out).
  try {
    const { error } = await supabase.from('activity_logs').insert({
      actor_type: actorType,
      actor_id: safeActorId(actorId),
      action,
      target_type: targetType || null,
      target_id: targetId || null,
      reason: reason || null,
      ip_address: ipAddress || null,
      metadata,
    });
    if (error) console.error('[activityLog] Failed to write activity log:', error.message);
  } catch (err) {
    // Logging must never crash the main request flow - just log to console.
    console.error('[activityLog] Failed to write activity log:', err.message);
  }
}

module.exports = { logActivity };
