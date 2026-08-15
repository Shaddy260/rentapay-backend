// src/controllers/baCompletedPayouts.controller.js
//
// BA Monthly Payment Details & Payout Workflow - Phase 4.
//
// ADMIN-only endpoints:
//   GET /api/brand-ambassadors/payout-link/completed-periods - months
//        that have paid entries, with a count + total per month, so
//        the admin can pick one without opening each.
//   GET /api/brand-ambassadors/payout-link/completed?periodKey=YYYY-MM
//        - read-only list of paid cards for that month (or every
//        month with paid entries if periodKey is omitted), plus
//        summary totals.
//   GET /api/brand-ambassadors/payout-link/completed/pdf?periodKey=
//        - the payout PDF for that selection, reusing
//        baPayoutQualificationReportPdf.service.js's look.

const { listCompletedPeriods, listCompleted, listPaymentHistory } = require('../services/baCompletedPayouts.service');
const { generateCompletedPayoutLinkPdf } = require('../services/baPayoutQualificationReportPdf.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

async function getCompletedPeriods(req, res) {
  try {
    const periods = await listCompletedPeriods();
    return res.json({ periods });
  } catch (err) {
    logger.error('[baCompletedPayouts] getCompletedPeriods error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load completed payout months.' });
  }
}

async function getCompleted(req, res) {
  try {
    const { periodKey } = req.query;
    const result = await listCompleted({ periodKey: periodKey || null });
    return res.json(result);
  } catch (err) {
    logger.error('[baCompletedPayouts] getCompleted error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load completed payments.' });
  }
}

async function downloadCompletedPdf(req, res) {
  try {
    const { periodKey } = req.query;
    const result = await listCompleted({ periodKey: periodKey || null });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ba-payout-completed-${periodKey || 'all'}.pdf"`
    );
    generateCompletedPayoutLinkPdf(res, {
      periodKey: periodKey || null,
      generatedAt: new Date().toISOString(),
      cards: result.cards,
      totals: result.totals,
    });
  } catch (err) {
    logger.error('[baCompletedPayouts] downloadCompletedPdf error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download the payout PDF.' });
  }
}

async function getPaymentHistory(req, res) {
  try {
    const result = await listPaymentHistory();
    return res.json(result);
  } catch (err) {
    logger.error('[baCompletedPayouts] getPaymentHistory error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load payment history.' });
  }
}

module.exports = {
  getCompletedPeriods,
  getCompleted,
  downloadCompletedPdf,
  getPaymentHistory,
};
