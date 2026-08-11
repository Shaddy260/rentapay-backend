// src/routes/baPayoutQualificationReport.routes.js
//
// Mounted at /api/brand-ambassadors in server.js, alongside the rest
// of the existing BA routes.
const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/baPayoutQualificationReport.controller');

const router = express.Router();

router.post('/payout-qualification-reports/generate', verifyToken, requireRole('admin'), ctrl.generate);
router.get('/payout-qualification-reports', verifyToken, requireRole('admin'), ctrl.list);
// NOTE: the `.csv` route must be registered before the plain `:id`
// route since Express would otherwise treat "123.csv" as the id param
// for GET /payout-qualification-reports/:id and never reach the CSV
// handler.
router.get('/payout-qualification-reports/:id.csv', verifyToken, requireRole('admin'), ctrl.downloadCsv);
// ITEM 12 - combined PDF (every BA, color-coded) and per-BA PDF.
// Both have more path segments than the plain `:id` route below, so
// there's no ambiguity with it the way there was with `.csv`.
router.get('/payout-qualification-reports/:id/pdf', verifyToken, requireRole('admin'), ctrl.downloadCombinedPdf);
router.get('/payout-qualification-reports/:id/ba/:baId/pdf', verifyToken, requireRole('admin'), ctrl.downloadBaPdf);
router.get('/payout-qualification-reports/:id', verifyToken, requireRole('admin'), ctrl.getOne);

module.exports = router;
