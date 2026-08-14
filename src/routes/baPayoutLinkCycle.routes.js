// src/routes/baPayoutLinkCycle.routes.js
//
// Mounted at /api/brand-ambassadors in server.js, alongside the rest
// of the existing BA routes. Phase 1 of the BA Monthly Payment
// Details & Payout Workflow - see ba-payout-link-plan.md.
const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/baPayoutLinkCycle.controller');
const submissionCtrl = require('../controllers/baPaymentSubmission.controller');
const pendingCtrl = require('../controllers/baPendingPayouts.controller');
const completedCtrl = require('../controllers/baCompletedPayouts.controller');

const router = express.Router();

// PUBLIC - the payment-details submission page validates its ?token=
// on load, before rendering the form (Phase 2 builds the form itself).
router.get('/payout-link/validate', ctrl.validatePayoutLinkToken);

// PUBLIC - Phase 2: the actual submission form (M-Pesa number, name,
// account email) and the "look my submission back up" endpoint used
// by the confirmation view.
router.post('/payout-link/submit', submissionCtrl.submitPayoutLinkDetails);
router.get('/payout-link/my-submission', submissionCtrl.getMyPayoutLinkSubmission);

// ADMIN - current month's cycle status + shareable public link.
router.get('/payout-link/current', verifyToken, requireRole('admin'), ctrl.getCurrentCycleStatus);

// ADMIN - Phase 3: Pending Payments view + mark-as-paid.
router.get('/payout-link/pending', verifyToken, requireRole('admin'), pendingCtrl.getPendingPayments);
router.get('/payout-link/awaiting-details', verifyToken, requireRole('admin'), pendingCtrl.getAwaitingDetails);
router.post('/payout-link/mark-paid', verifyToken, requireRole('admin'), pendingCtrl.postMarkPaid);

// ADMIN - Phase 4: Completed list (read-only) + PDF export.
router.get('/payout-link/completed-periods', verifyToken, requireRole('admin'), completedCtrl.getCompletedPeriods);
router.get('/payout-link/completed/pdf', verifyToken, requireRole('admin'), completedCtrl.downloadCompletedPdf);
router.get('/payout-link/completed', verifyToken, requireRole('admin'), completedCtrl.getCompleted);

module.exports = router;
