// src/controllers/generalManagerRevert.controller.js
//
// RentaPay — General Manager Sectioned Build Spec, Section 10.
//
// "From under each General Manager's account card/profile, admin has
// a revert capability... Admin selects a date range under that
// General Manager's profile. Within that range, admin can choose to:
// Revert all actions in that range at once, or go through them one by
// one and selectively revert individual actions. Reverting an action
// restores the affected record literally to its exact previous
// state."
//
// Admin-only (see admin.routes.js — requireRole('admin') on top of
// this router's shared admin+GM gate, same pattern as the roster and
// log-export routes above it). A General Manager can browse their own
// log page (Section 8) but never gets a revert affordance there —
// GmActivityLogView.jsx only renders the Revert button when the
// caller explicitly passes canRevert=true, which AdminGeneralManagerLogs.jsx
// does and ManagerAccountDashboard.jsx's "My Activity" tab does not.
//
// The actual restore logic (exact-state undo, per REVERTIBLE_ACTIONS)
// already lives in generalManagerActivityLog.service.js — this
// controller is just the thin, validated HTTP entry point onto it.

const supabase = require('../config/supabase');
const { revertGmLog, revertGmLogsInRange } = require('../services/generalManagerActivityLog.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

async function assertManagerExists(id) {
  const { data, error } = await supabase.from('general_managers').select('id').eq('id', id).maybeSingle();
  if (error) throw error;
  return !!data;
}

/** POST /api/admin/general-managers/:id/logs/:logId/revert (admin-only) — revert a single log entry. */
async function revertSingleLog(req, res) {
  const { id, logId } = req.params;
  try {
    if (!(await assertManagerExists(id))) return res.status(404).json({ error: 'General Manager not found.' });

    // revertGmLog() already checks the log belongs to a real,
    // not-yet-reverted, revert-eligible entry — but confirm it belongs
    // to *this* manager before touching anything, so admin can't
    // revert one manager's log entry from another manager's URL.
    const { data: log, error: logErr } = await supabase
      .from('general_manager_activity_logs')
      .select('id, general_manager_id')
      .eq('id', logId)
      .maybeSingle();
    if (logErr) throw logErr;
    if (!log) return res.status(404).json({ error: 'Log entry not found.' });
    if (log.general_manager_id !== id) return res.status(404).json({ error: 'Log entry not found.' });

    const result = await revertGmLog(logId, 'super-admin');
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json({ success: true });
  } catch (err) {
    logger.error('[generalManagerRevert] revertSingleLog error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to revert this action.' });
  }
}

/**
 * POST /api/admin/general-managers/:id/logs/revert-range (admin-only)
 * Body: { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
 * Bulk-reverts every eligible, not-yet-reverted log for this manager
 * within the range (omitting both bounds reverts their entire
 * revertible history). Each entry is reverted independently — one
 * failure doesn't stop the rest — and the response reports exactly
 * which log ids succeeded and which didn't, so admin isn't left
 * guessing.
 */
async function revertRange(req, res) {
  const { id } = req.params;
  const { from, to } = req.body || {};
  try {
    if (!(await assertManagerExists(id))) return res.status(404).json({ error: 'General Manager not found.' });

    let fromIso;
    let toIso;
    if (from) {
      const d = new Date(from);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid "from" date.' });
      d.setHours(0, 0, 0, 0);
      fromIso = d.toISOString();
    }
    if (to) {
      const d = new Date(to);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid "to" date.' });
      d.setHours(23, 59, 59, 999);
      toIso = d.toISOString();
    }

    const results = await revertGmLogsInRange(id, fromIso, toIso, 'super-admin');
    return res.json({
      success: true,
      revertedCount: results.reverted.length,
      failedCount: results.failed.length,
      reverted: results.reverted,
      failed: results.failed,
    });
  } catch (err) {
    logger.error('[generalManagerRevert] revertRange error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to revert actions in this range.' });
  }
}

module.exports = { revertSingleLog, revertRange };
