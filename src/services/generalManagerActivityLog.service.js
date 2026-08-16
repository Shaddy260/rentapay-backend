// src/services/generalManagerActivityLog.service.js
//
// RentaPay — General Manager Sectioned Build Spec, Sections 7 & 10.
//
// Section 7 (write side): logGmActivity() writes one row to
// general_manager_activity_logs and immediately notifies admin
// in-app + push. Called automatically from activityLog.service.js's
// logActivity() whenever actorType === 'general_manager' - no
// controller needs to call this directly, though several already pass
// richer metadata (before/after/affected-person-label) through
// logActivity() to make this row genuinely useful rather than bare
// IDs (see admin.controller.js, brandAmbassador.controller.js,
// moderation.controller.js).
//
// Section 10 (revert side): revertGmLog() / revertGmLogsInRange()
// restore the exact `initial_data` snapshot captured at write time.
// Only actions in REVERTIBLE_ACTIONS are ever marked is_revertible, so
// a bulk revert can never silently touch something the spec doesn't
// name (Section 10: "Suspending an account, Activating an account,
// Any edits touching finances, Adding an account, Deleting an
// account, Alteration of any account/entity status").

const supabase = require('../config/supabase');
const { notify } = require('./notify.service');
const { captureException } = require('./sentry.service');
const logger = require('../utils/logger');

// action name -> { table, mode }. `mode` decides how the revert is
// carried out:
//   'update' - initial_data is a { column: value } patch, applied
//              back with .update(initial_data).eq('id', affectedId).
//              Used for status flips (suspend/activate, warn/
//              unsuspend) and finance-touching edits.
//   'delete' - this action CREATED the row (e.g. general_manager
//              creating a General Manager account is admin-only and
//              out of scope, but a GM adding a tenant/landlord isn't) -
//              reverting means deleting the row the action added.
//   'insert' - this action DELETED the row - reverting re-inserts the
//              full pre-delete snapshot captured in initial_data.
// Anything not listed here is simply never marked revertible - Admin
// Revert only ever offers to undo actions this table explicitly knows
// how to reverse cleanly.
const REVERTIBLE_ACTIONS = {
  landlord_suspended: { table: 'landlords', mode: 'update' },
  landlord_active: { table: 'landlords', mode: 'update' },
  landlord_deleted: { table: 'landlords', mode: 'insert' },
  landlord_subscription_edited: { table: 'landlords', mode: 'update' }, // "edits touching finances"
  ba_suspended: { table: 'brand_ambassadors', mode: 'update' },
  ba_reactivated: { table: 'brand_ambassadors', mode: 'update' },
  ba_offboarded: { table: 'brand_ambassadors', mode: 'update' },
  ba_restored: { table: 'brand_ambassadors', mode: 'update' },
  account_suspended_permanent: { table: null, mode: 'update' }, // table resolved per-row from affected_role (moderation spans landlord/manager/tenant)
  account_suspended_temporary: { table: null, mode: 'update' },
  account_unsuspended: { table: null, mode: 'update' },
  tenant_added: { table: 'tenants', mode: 'delete' },
  tenant_deleted: { table: 'tenants', mode: 'insert' },
  landlord_added: { table: 'landlords', mode: 'delete' },
};

const MODERATION_ROLE_TABLE = { landlord: 'landlords', manager: 'property_managers', tenant: 'tenants' };

function resolveTable(action, affectedRole) {
  const cfg = REVERTIBLE_ACTIONS[action];
  if (!cfg) return null;
  if (cfg.table) return cfg;
  const table = MODERATION_ROLE_TABLE[affectedRole];
  return table ? { ...cfg, table } : null;
}

function humanize(action) {
  return String(action || '')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * SECTION 7 — writes one detailed log row for a General Manager's
 * PIN-confirmed action, then notifies admin immediately (in-app +
 * push, via the same notify() every other admin alert already uses).
 * Never throws - a logging/notification hiccup must never surface as
 * a failure of the action that actually mattered.
 */
async function logGmActivity({
  generalManagerId,
  action,
  dataType,
  affectedRole,
  affectedPersonId,
  affectedPersonLabel,
  initialData,
  correctedData,
  reason,
  context,
  ipAddress,
}) {
  try {
    const isRevertible = !!resolveTable(action, affectedRole) && initialData != null;

    const { data: row, error } = await supabase
      .from('general_manager_activity_logs')
      .insert({
        general_manager_id: generalManagerId,
        action,
        data_type: dataType || humanize(action),
        affected_role: affectedRole || null,
        affected_person_id: affectedPersonId != null ? String(affectedPersonId) : null,
        affected_person_label: affectedPersonLabel || null,
        initial_data: initialData ?? null,
        corrected_data: correctedData ?? null,
        reason: reason || '(no reason recorded)',
        context: context && Object.keys(context).length ? context : null,
        ip_address: ipAddress || null,
        is_revertible: isRevertible,
      })
      .select('id')
      .single();
    if (error) throw error;

    // "Admin is notified immediately - both as an in-app notification
    // and as a push notification." notify('admin', ...) already writes
    // the in-app inbox row AND fires a real push (urgent defaults to
    // true) in one call - see notify.service.js.
    const { data: manager } = await supabase.from('general_managers').select('full_name').eq('id', generalManagerId).maybeSingle();
    const gmName = manager?.full_name || 'A General Manager';
    const who = affectedPersonLabel ? ` — ${affectedPersonLabel}` : '';
    notify(
      'admin',
      'super-admin',
      null,
      `${gmName} ${humanize(action).toLowerCase()}${who}. Reason: ${reason || 'none given'}`,
      { category: 'account', title: 'General Manager activity', urgent: true }
    ).catch((notifyErr) => logger.error('[gmActivityLog] admin notify failed:', notifyErr.message));

    return row;
  } catch (err) {
    logger.error('[gmActivityLog] logGmActivity failed:', err.message);
    captureException(err);
    return null;
  }
}

// ---------------------------------------------------------------------
// SECTION 8 — Per-Manager Log Pages (day / week / month views)
// ---------------------------------------------------------------------

/** Returns [startIso, endIso) for the given view anchored on `date` (defaults to now). */
function rangeFor(view, dateStr) {
  const anchor = dateStr ? new Date(dateStr) : new Date();
  if (Number.isNaN(anchor.getTime())) throw new Error('Invalid date.');

  let start;
  let end;
  if (view === 'week') {
    // Monday-start week, matching how activity logs read elsewhere in this codebase.
    const day = (anchor.getDay() + 6) % 7; // 0 = Monday
    start = new Date(anchor);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - day);
    end = new Date(start);
    end.setDate(end.getDate() + 7);
  } else if (view === 'month') {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  } else {
    // 'day' default
    start = new Date(anchor);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(end.getDate() + 1);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

async function listManagerLogs(generalManagerId, { view = 'day', date } = {}) {
  const { start, end } = rangeFor(view, date);
  const { data, error } = await supabase
    .from('general_manager_activity_logs')
    .select('*')
    .eq('general_manager_id', generalManagerId)
    .gte('created_at', start)
    .lt('created_at', end)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return { logs: data || [], rangeStart: start, rangeEnd: end };
}

async function listManagerLogsBetween(generalManagerId, fromIso, toIso) {
  let query = supabase.from('general_manager_activity_logs').select('*').eq('general_manager_id', generalManagerId).order('created_at', { ascending: false });
  if (fromIso) query = query.gte('created_at', fromIso);
  if (toIso) query = query.lte('created_at', toIso);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ---------------------------------------------------------------------
// SECTION 10 — Admin Revert Capability
// ---------------------------------------------------------------------

/**
 * Reverts a single log entry: restores the record to `initial_data`,
 * exactly as it was immediately before that specific edit - not an
 * approximation or recalculation.
 */
async function revertGmLog(logId, revertedBy) {
  const { data: log, error } = await supabase.from('general_manager_activity_logs').select('*').eq('id', logId).maybeSingle();
  if (error) throw error;
  if (!log) return { ok: false, error: 'Log entry not found.' };
  if (log.reverted_at) return { ok: false, error: 'This action has already been reverted.' };
  if (!log.is_revertible) return { ok: false, error: 'This action is not eligible for revert.' };

  const cfg = resolveTable(log.action, log.affected_role);
  if (!cfg) return { ok: false, error: 'This action type cannot be reverted automatically.' };

  try {
    if (cfg.mode === 'update') {
      const { error: updErr } = await supabase.from(cfg.table).update(log.initial_data).eq('id', log.affected_person_id);
      if (updErr) throw updErr;
    } else if (cfg.mode === 'delete') {
      // The GM's action CREATED this row - revert removes it.
      const { error: delErr } = await supabase.from(cfg.table).delete().eq('id', log.affected_person_id);
      if (delErr) throw delErr;
    } else if (cfg.mode === 'insert') {
      // The GM's action DELETED this row - revert restores the full
      // pre-delete snapshot captured in initial_data.
      const { error: insErr } = await supabase.from(cfg.table).insert(log.initial_data);
      if (insErr) throw insErr;
    }

    const { error: markErr } = await supabase
      .from('general_manager_activity_logs')
      .update({ reverted_at: new Date().toISOString(), reverted_by: revertedBy || 'super-admin' })
      .eq('id', logId);
    if (markErr) throw markErr;

    return { ok: true };
  } catch (err) {
    logger.error('[gmActivityLog] revertGmLog failed:', err.message);
    captureException(err);
    return { ok: false, error: 'Failed to revert this action.' };
  }
}

/** Reverts every eligible, not-yet-reverted log for this manager within [fromIso, toIso]. */
async function revertGmLogsInRange(generalManagerId, fromIso, toIso, revertedBy) {
  let query = supabase
    .from('general_manager_activity_logs')
    .select('id')
    .eq('general_manager_id', generalManagerId)
    .eq('is_revertible', true)
    .is('reverted_at', null);
  if (fromIso) query = query.gte('created_at', fromIso);
  if (toIso) query = query.lte('created_at', toIso);
  const { data: candidates, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;

  const results = { reverted: [], failed: [] };
  // Sequential, oldest-mutation-risk-first is unnecessary here since
  // each row only ever touches its own affected record, but running
  // sequentially (not Promise.all) keeps this simple to reason about
  // and keeps DB load predictable for a potentially large bulk revert.
  for (const c of candidates || []) {
    // eslint-disable-next-line no-await-in-loop
    const result = await revertGmLog(c.id, revertedBy);
    if (result.ok) results.reverted.push(c.id);
    else results.failed.push({ id: c.id, error: result.error });
  }
  return results;
}

module.exports = {
  logGmActivity,
  listManagerLogs,
  listManagerLogsBetween,
  revertGmLog,
  revertGmLogsInRange,
  humanize,
};
