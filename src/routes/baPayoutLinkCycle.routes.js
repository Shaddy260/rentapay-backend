// src/routes/baPayoutLinkCycle.routes.js
//
// Mounted at /api/brand-ambassadors in server.js. BUILD SPEC PHASE 10
// (v2) - Universal BA Payout Links + Email/OTP Gate.
const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/baPayoutLinkCycle.controller');
const submissionCtrl = require('../controllers/baPaymentSubmission.controller');
const pendingCtrl = require('../controllers/baPendingPayouts.controller');
const completedCtrl = require('../controllers/baCompletedPayouts.controller');

const router = express.Router();

// PUBLIC - the one-time, universal, non-expiring submission link at
// /ba-payout-submit. Gated by email + OTP, never by a token in the URL.
router.post('/payout-link/submit/request-otp', submissionCtrl.requestSubmitOtp);
router.post('/payout-link/submit/verify-otp', submissionCtrl.verifySubmitOtp);
router.post('/payout-link/submit', submissionCtrl.submitPayoutLinkDetails);

// PUBLIC - the universal, admin-issued, 24h-rotating correction link
// at /ba-payout-edit?token=..., also gated by email + OTP.
router.get('/payout-link/edit/validate', submissionCtrl.validateEditLink);
router.post('/payout-link/edit/request-otp', submissionCtrl.requestEditOtp);
router.post('/payout-link/edit/verify-otp', submissionCtrl.verifyEditOtp);
router.post('/payout-link/edit', submissionCtrl.editPayoutLinkDetails);

// PUBLIC - re-open the confirmation/prefill view, scoped to a verified
// verificationToken (never a bare email/id lookup).
router.get('/payout-link/my-submission', submissionCtrl.getMyPayoutLinkSubmission);

// ADMIN - current period bookkeeping (informational only - earnings
// grouping, not a shareable per-BA submission link anymore).
router.get('/payout-link/current', verifyToken, requireRole('admin'), ctrl.getCurrentCycleStatus);

// ADMIN - Pending tab + mark-as-paid.
router.get('/payout-link/pending', verifyToken, requireRole('admin'), pendingCtrl.getPendingPayments);
router.get('/payout-link/awaiting-details', verifyToken, requireRole('admin'), pendingCtrl.getAwaitingDetails);
router.post('/payout-link/mark-paid', verifyToken, requireRole('admin'), pendingCtrl.postMarkPaid);

// ADMIN - Completed tab (read-only, browsable by month) + PDF export.
router.get('/payout-link/completed-periods', verifyToken, requireRole('admin'), completedCtrl.getCompletedPeriods);
router.get('/payout-link/completed/pdf', verifyToken, requireRole('admin'), completedCtrl.downloadCompletedPdf);
router.get('/payout-link/completed', verifyToken, requireRole('admin'), completedCtrl.getCompleted);

// ADMIN - Payment history tab: the full, append-only, all-time log.
router.get('/payout-link/history', verifyToken, requireRole('admin'), completedCtrl.getPaymentHistory);

// ADMIN - manage the universal 24h correction link. The only route
// back into any BA's on-file details after their one-time submission.
router.get('/payout-link/edit-link/status', verifyToken, requireRole('admin'), submissionCtrl.getEditLinkStatusHandler);
router.post('/payout-link/edit-link/generate', verifyToken, requireRole('admin'), submissionCtrl.postGenerateEditLink);

module.exports = router;
