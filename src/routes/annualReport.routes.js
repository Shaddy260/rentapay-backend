// src/routes/annualReport.routes.js
const express = require('express');
const router = express.Router();
const annualReportController = require('../controllers/annualReport.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);
router.get('/portfolio/pdf', requireRole('landlord', 'manager'), annualReportController.getAnnualPortfolioPdf);
router.get('/tax-summary/pdf', requireRole('landlord', 'manager'), annualReportController.getTaxSummaryPdf);

// Admin: same reports for a given landlord, mirroring the pattern used
// for /api/dashboard/statistics/:landlordId.
router.get('/portfolio/pdf/:landlordId', requireRole('admin'), annualReportController.getAnnualPortfolioPdf);
router.get('/tax-summary/pdf/:landlordId', requireRole('admin'), annualReportController.getTaxSummaryPdf);

module.exports = router;
