// src/controllers/baPayoutQualificationReport.controller.js
const service = require('../services/baPayoutQualificationReport.service');
const logger = require('../utils/logger');
const { captureException } = require('../services/sentry.service');

// POST /api/brand-ambassadors/payout-qualification-reports/generate
async function generate(req, res) {
  try {
    const { periodType, periodKey } = req.body || {};
    const report = await service.buildAndPersistReport({
      periodType: periodType || 'month',
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
    const csv = service.reportToCsv(report);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ba-payout-qualification-report-${report.periodKey}.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error('[baPayoutQualificationReport] downloadCsv failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to download the report.' });
  }
}

module.exports = { generate, list, getOne, downloadCsv };
