// src/controllers/baPendingPayouts.controller.js
//
// BA Monthly Payment Details & Payout Workflow - Phase 3.
//
// ADMIN-only endpoints:
//   GET  /api/brand-ambassadors/payout-link/pending           - grouped
//        Pending Payments cards (across every cycle with unpaid
//        entries).
//   GET  /api/brand-ambassadors/payout-link/awaiting-details  - BAs
//        with earnings this cycle who haven't submitted yet.
//   POST /api/brand-ambassadors/payout-link/mark-paid         - bulk
//        (or single) mark-as-paid, moves cards out of Pending.

const { listPendingPayments, listAwaitingDetails, markPaid } = require('../services/baPendingPayouts.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

async function getPendingPayments(req, res) {
  try {
    const result = await listPendingPayments();
    return res.json(result);
  } catch (err) {
    logger.error('[baPendingPayouts] getPendingPayments error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load pending payments.' });
  }
}

async function getAwaitingDetails(req, res) {
  try {
    const bas = await listAwaitingDetails();
    return res.json({ bas });
  } catch (err) {
    logger.error('[baPendingPayouts] getAwaitingDetails error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load BAs awaiting payment details.' });
  }
}

async function postMarkPaid(req, res) {
  try {
    const { submissionIds, submissionId } = req.body || {};
    const ids = Array.isArray(submissionIds) ? submissionIds : submissionId ? [submissionId] : [];
    const result = await markPaid({ submissionIds: ids, adminId: req.user?.id || null });
    return res.json(result);
  } catch (err) {
    if (err.validation) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('[baPendingPayouts] postMarkPaid error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to mark selected payments as paid.' });
  }
}

module.exports = {
  getPendingPayments,
  getAwaitingDetails,
  postMarkPaid,
};
