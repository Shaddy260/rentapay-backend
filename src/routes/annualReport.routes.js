// src/routes/annualReport.routes.js
const express = require('express');
const router = express.Router();
const annualReportController = require('../controllers/annualReport.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');

router.use(verifyToken);
router.get('/portfolio/pdf', requireRole('landlord', 'manager'), annualReportController.getAnnualPortfolioPdf);
// DIRECT REQUEST: caretakers should not see/access the tax summary
// report - it's landlord/manager-facing filing paperwork. requireRole
// alone isn't enough here since a caretaker IS role='manager' (just
// role_level='caretaker'); requireNotCaretaker is the existing helper
// for exactly this distinction.
router.get('/tax-summary/pdf', requireRole('landlord', 'manager'), requireNotCaretaker('Tax summary reports are not available to caretaker accounts. Contact the landlord or property manager.'), annualReportController.getTaxSummaryPdf);
router.get('/financial-report/csv', requireRole('landlord', 'manager'), annualReportController.getFinancialReportCsv);

// Admin: same reports for a given landlord, mirroring the pattern used
// for /api/dashboard/statistics/:landlordId.
router.get('/portfolio/pdf/:landlordId', requireRole('admin'), annualReportController.getAnnualPortfolioPdf);
router.get('/tax-summary/pdf/:landlordId', requireRole('admin'), annualReportController.getTaxSummaryPdf);
router.get('/financial-report/csv/:landlordId', requireRole('admin'), annualReportController.getFinancialReportCsv);

module.exports = router;
