// src/controllers/generalManagerReview.controller.js
//
// RentaPay — General Manager Accounts, Admin Confirmation Queue.
//
// Direct request: "the general manager account actions need
// confirmation by the admin even after they do it with the pin ...
// these pending actions from general managers [should] land in
// admin portal ... as well come as banner and have their own
// dedicated ui, and admin can confirm or reject one by one or
// multiple by selecting or all."
//
// Every sensitive/revertible GM action (see REVERTIBLE_ACTIONS in
// generalManagerActivityLog.service.js) is written with
// admin_review_status = 'pending' the moment it happens. This
// controller is the thin, admin-only HTTP surface onto that queue:
// list what's pending across every manager, and confirm or reject
// one entry, several selected entries, or every pending entry at
// once. Confirming just clears the queue entry (the action already
// took effect). Rejecting undoes it immediately, reusing the same
// exact-state revert Section 10 already built.
//
// Mounted admin-only under /api/admin/general-managers/pending-reviews
// (see admin.routes.js) - a General Manager never sees this queue,
// only admin.

const { listPendingReviews, countPendingReviews, reviewGmLog, bulkReviewGmLogs, reviewAllPending } = require('../services/generalManagerActivityLog.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

/** GET /api/admin/general-managers/pending-reviews */
async function listPending(req, res) {
  try {
    const logs = await listPendingReviews();
    return res.json({ logs, count: logs.length });
  } catch (err) {
    logger.error('[generalManagerReview] listPending error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load pending actions.' });
  }
}

/** GET /api/admin/general-managers/pending-reviews/count — lightweight, for sidebar badge / incoming banner polling. */
async function getPendingCount(req, res) {
  try {
    const count = await countPendingReviews();
    return res.json({ count });
  } catch (err) {
    logger.error('[generalManagerReview] getPendingCount error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load pending action count.' });
  }
}

function validDecision(decision) {
  return decision === 'confirm' || decision === 'reject';
}

/** POST /api/admin/general-managers/pending-reviews/:logId/review — body: { decision: 'confirm' | 'reject' } */
async function reviewOne(req, res) {
  const { logId } = req.params;
  const { decision } = req.body || {};
  if (!validDecision(decision)) return res.status(400).json({ error: 'Decision must be "confirm" or "reject".' });

  try {
    const result = await reviewGmLog(logId, decision, 'super-admin');
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json({ success: true });
  } catch (err) {
    logger.error('[generalManagerReview] reviewOne error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to review this action.' });
  }
}

/**
 * POST /api/admin/general-managers/pending-reviews/bulk-review
 * Body: { decision: 'confirm' | 'reject', logIds?: string[], all?: boolean }
 * Either a specific checkbox-selected set of ids, or `all: true` to
 * resolve every currently pending action across every manager in one go.
 */
async function reviewBulk(req, res) {
  const { decision, logIds, all } = req.body || {};
  if (!validDecision(decision)) return res.status(400).json({ error: 'Decision must be "confirm" or "reject".' });
  if (!all && (!Array.isArray(logIds) || logIds.length === 0)) {
    return res.status(400).json({ error: 'Select at least one action, or pass "all": true.' });
  }

  try {
    const results = all ? await reviewAllPending(decision, 'super-admin') : await bulkReviewGmLogs(logIds, decision, 'super-admin');
    return res.json({
      success: true,
      succeededCount: results.succeeded.length,
      failedCount: results.failed.length,
      succeeded: results.succeeded,
      failed: results.failed,
    });
  } catch (err) {
    logger.error('[generalManagerReview] reviewBulk error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to review the selected actions.' });
  }
}

module.exports = { listPending, getPendingCount, reviewOne, reviewBulk };
