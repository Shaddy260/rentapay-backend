// src/controllers/baPayoutQualificationReport.controller.js
const service = require('../services/baPayoutQualificationReport.service');
const {
  generateSingleBaPayoutQualificationPdf,
  generateCombinedPayoutQualificationPdf,
} = require('../services/baPayoutQualificationReportPdf.service');
const { brandCsv, brandedFilename } = require('../services/csvBranding.service');
const logger = require('../utils/logger');
const { captureException } = require('../services/sentry.service');

// POST /api/brand-ambassadors/payout-qualification-reports/generate
//
// Section F: a Payout Run is generated for one billing cycle
// (periodKey = 'YYYY-MM', e.g. '2026-08') - periodType is no longer
// accepted from the client (weekly runs don't map to a billing cycle);
// an invalid/missing periodKey falls back to the current month inside
// the service.
async function generate(req, res) {
  try {
    const { periodKey } = req.body || {};
    const report = await service.buildAndPersistReport({
      periodKey,
      // This project has no `admins` table - admin auth is a single
      // credential and req.user.id is the literal string 'super-admin'
      // (see auth.controller.js's adminLogin/signToken).
      adminId: req.user?.id,
      adminName: req.user?.id === 'super-admin' ? 'Super Admin' : req.user?.id,
    });
    res.json(report);
  } catch (err) {
    logger.error('[baPayoutQualificationReport] generate failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to generate the report.' });
  }
}

// GET /api/brand-ambassadors/payout-qualification-reports
async function list(req, res) {
  try {
    const reports = await service.listReports();
    res.json({ reports });
  } catch (err) {
    logger.error('[baPayoutQualificationReport] list failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to load past reports.' });
  }
}

// GET /api/brand-ambassadors/payout-qualification-reports/:id
async function getOne(req, res) {
  try {
    const report = await service.getReportById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    res.json(report);
  } catch (err) {
    logger.error('[baPayoutQualificationReport] getOne failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to load the report.' });
  }
}

// GET /api/brand-ambassadors/payout-qualification-reports/:id.csv
async function downloadCsv(req, res) {
  try {
    const reportId = req.params.id.replace(/\.csv$/, '');
    const report = await service.getReportById(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const csv = brandCsv({
      title: 'BA Payout Qualification Report',
      meta: [`Period: ${report.periodKey}`],
      body: service.reportToCsv(report),
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${brandedFilename('ba-payout-qualification-report', report.periodKey, 'csv')}"`);
    res.send(csv);
  } catch (err) {
    logger.error('[baPayoutQualificationReport] downloadCsv failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to download the report.' });
  }
}

// GET /api/brand-ambassadors/payout-qualification-reports/:id/pdf
// ITEM 12 - the combined/complete PDF: every BA's block one after
// another, color-coded green (qualifies) / orange (doesn't), ending
// with the grand total for the run.
async function downloadCombinedPdf(req, res) {
  try {
    const report = await service.getReportById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${brandedFilename('ba-payout-qualification-report', report.periodKey, 'pdf')}"`);
    generateCombinedPayoutQualificationPdf(res, report);
  } catch (err) {
    logger.error('[baPayoutQualificationReport] downloadCombinedPdf failed', err);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download the combined PDF.' });
  }
}

// GET /api/brand-ambassadors/payout-qualification-reports/:id/ba/:baId/pdf
// ITEM 12 - a single BA's own color-coded PDF, downloadable on its
// own without paging through the others.
async function downloadBaPdf(req, res) {
  try {
    const report = await service.getReportById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${brandedFilename('ba-payout-qualification', req.params.baId, report.periodKey, 'pdf')}"`);
    generateSingleBaPayoutQualificationPdf(res, report, req.params.baId);
  } catch (err) {
    logger.error('[baPayoutQualificationReport] downloadBaPdf failed', err);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download the PDF.' });
  }
}

module.exports = { generate, list, getOne, downloadCsv, downloadCombinedPdf, downloadBaPdf };
