// src/controllers/generalManagerLog.controller.js
//
// RentaPay — General Manager Sectioned Build Spec, Section 8.
//
// "Each General Manager has their own dedicated log page - not a
// shared feed mixed with other managers' activity. This page
// organizes activity into day, week, and month views... admin (and
// the General Manager themselves, if intended) can browse a specific
// manager's full activity history."
//
// Two entry points, same underlying data:
//   - getManagerLogsForAdmin: admin browsing ANY manager's log page
//     (mounted under /api/admin/general-managers/:id/logs, admin-only -
//     see admin.routes.js).
//   - getMyLogs: a General Manager browsing their OWN log page
//     (mounted under /api/manager-account/my-logs, general_manager-
//     only - see generalManager.routes.js). Always reads req.user.id,
//     never a param, so a GM can only ever see their own history.
//
// Section 9 (PDF export) and Section 10 (revert) live in their own
// controllers/routes but share the same listManagerLogsBetween() /
// revert* functions from generalManagerActivityLog.service.js.

const supabase = require('../config/supabase');
const { listManagerLogs, listManagerLogsBetween } = require('../services/generalManagerActivityLog.service');
const { generateGmActivityLogPdf } = require('../services/generalManagerLogPdf.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const VALID_VIEWS = ['day', 'week', 'month'];

async function fetchLogsForManager(managerId, query, res) {
  const view = VALID_VIEWS.includes(query.view) ? query.view : 'day';
  try {
    const { logs, rangeStart, rangeEnd } = await listManagerLogs(managerId, { view, date: query.date });
    return res.json({ view, rangeStart, rangeEnd, logs });
  } catch (err) {
    logger.error('[generalManagerLog] fetchLogsForManager error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load activity log.' });
  }
}

/** GET /api/admin/general-managers/:id/logs?view=day|week|month&date=YYYY-MM-DD (admin-only) */
async function getManagerLogsForAdmin(req, res) {
  const { id } = req.params;
  const { data: manager, error } = await supabase.from('general_managers').select('id, full_name').eq('id', id).maybeSingle();
  if (error) { captureException(error); return res.status(500).json({ error: 'Failed to load General Manager.' }); }
  if (!manager) return res.status(404).json({ error: 'General Manager not found.' });
  req.__gmManagerName = manager.full_name; // available to a caller wanting it, harmless if unused
  return fetchLogsForManager(id, req.query, res);
}

/** GET /api/manager-account/my-logs?view=day|week|month&date=YYYY-MM-DD (general_manager-only, own history) */
async function getMyLogs(req, res) {
  return fetchLogsForManager(req.user.id, req.query, res);
}

// SECTION 9 — Styled PDF Export of Logs.
//
// "From a General Manager's log page, logs can be exported as a
// styled PDF report... This export supports a date-range selection,
// so admin can pull a complete, presentable record of 'everything
// this General Manager did within this specific window'."
//
// Admin-only, matching getManagerLogsForAdmin above (mounted under
// /api/admin/general-managers/:id/logs/export.pdf - see
// admin.routes.js). `from`/`to` are plain YYYY-MM-DD dates; `to` is
// treated as inclusive of the whole day. Omitting both exports the
// manager's entire history.
function dayBoundsIso(from, to) {
  let fromIso;
  let toIso;
  if (from) {
    const d = new Date(from);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid "from" date.');
    d.setHours(0, 0, 0, 0);
    fromIso = d.toISOString();
  }
  if (to) {
    const d = new Date(to);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid "to" date.');
    d.setHours(23, 59, 59, 999);
    toIso = d.toISOString();
  }
  return { fromIso, toIso };
}

/** GET /api/admin/general-managers/:id/logs/export.pdf?from=YYYY-MM-DD&to=YYYY-MM-DD (admin-only) */
async function exportManagerLogsPdf(req, res) {
  const { id } = req.params;
  const { from, to } = req.query;

  try {
    const { data: manager, error } = await supabase.from('general_managers').select('id, full_name').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!manager) return res.status(404).json({ error: 'General Manager not found.' });

    const { fromIso, toIso } = dayBoundsIso(from, to);
    const logs = await listManagerLogsBetween(id, fromIso, toIso);

    const rangeLabel = from || to
      ? `${from ? new Date(from).toLocaleDateString('en-GB') : 'earliest'} – ${to ? new Date(to).toLocaleDateString('en-GB') : 'latest'}`
      : 'Full history';
    const dateSlug = `${from || 'all'}_${to || 'all'}`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rentapay-gm-activity-${manager.full_name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${dateSlug}.pdf"`);

    generateGmActivityLogPdf(res, { managerName: manager.full_name, rangeLabel, logs });
  } catch (err) {
    logger.error('[generalManagerLog] exportManagerLogsPdf error:', err.message);
    captureException(err);
    if (!res.headersSent) return res.status(400).json({ error: err.message || 'Failed to export activity log.' });
    return res.end();
  }
}

module.exports = { getManagerLogsForAdmin, getMyLogs, exportManagerLogsPdf };
