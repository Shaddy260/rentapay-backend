const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const paymentController = require('../controllers/payment.controller');
const pendingPaymentConfirmationController = require('../controllers/pendingPaymentConfirmation.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');

// HARDENING (2A): dedicated limiter for the manual payment-submission
// endpoint - additive, doesn't touch the existing /api/auth limiter in
// server.js. Returns the same catchable ApiError shape as every other
// error response in this controller (a plain { error } body) rather
// than express-rate-limit's raw default, so the frontend's existing
// ApiError handling in client.js needs no special-casing for 429s.
const paybillSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many submissions - please wait a few minutes and try again.' }),
});

// Daraja callback must be PUBLIC (no auth) - Safaricom calls this directly.
router.post('/callback', paymentController.handleSTKCallback);

// Also public/unauthenticated: this is polled DURING landlord
// registration, before the account is verified and before any JWT
// exists yet. The checkoutRequestId itself (a long random Safaricom
// ID, never guessable) is the only thing needed to look it up, same
// trust level as the Daraja callback above.
router.get('/subscription-status/:checkoutRequestId', paymentController.checkSubscriptionPaymentStatus);

// FIX (direct request: scout county payments should be pollable/
// self-healing exactly like landlord subscription payments already
// are). A Scout is always logged in already when they trigger this
// STK push (unlike landlord registration), so this sits after
// verifyToken below rather than being public.

// Registration-time manual payment fallback (direct request - see
// landlordManualSubscriptionPayment.controller.js for the full why).
// Public for the same reason as the STK poll right above: no JWT
// exists yet at this point in the signup flow.
const manualSubPaymentControllerForRegistration = require('../controllers/landlordManualSubscriptionPayment.controller');
router.post('/subscription-manual/register', paybillSubmitLimiter, manualSubPaymentControllerForRegistration.submitRegistrationManualPayment);
router.get('/subscription-manual/register/:landlordId/status', manualSubPaymentControllerForRegistration.checkRegistrationManualPaymentStatus);

router.use(verifyToken);
router.get('/scout-county-status/:checkoutRequestId', requireRole('scout'), paymentController.checkScoutCountyPaymentStatus);
router.get('/history', requireRole('landlord', 'manager'), paymentController.getLandlordPaymentHistory);
router.delete('/history/:paymentId', requireRole('landlord', 'manager'), requireNotCaretaker('Caretakers cannot delete payment records. Contact the landlord or property manager.'), paymentController.deletePayment);
router.get('/history/:landlordId', requireRole('admin'), paymentController.getLandlordPaymentHistory);
router.post('/stk-push', requireRole('tenant'), paymentController.initiateRentSTKPush);
router.get('/rent-status/:checkoutRequestId', requireRole('tenant'), paymentController.checkRentPaymentStatus);
router.post('/paybill-submit', requireRole('tenant'), paybillSubmitLimiter, paymentController.submitPaybillTransaction);
router.get('/my-latest-confirmation', requireRole('tenant'), paymentController.getMyLatestPaybillConfirmation);
router.get('/:paymentId/receipt', requireRole('tenant'), paymentController.downloadReceiptPdf);
router.post(
  '/manual',
  requireRole('landlord', 'manager'),
  requireNotCaretaker('Caretakers cannot record payments. Contact the landlord or property manager.'),
  paymentController.recordManualPayment
);

// Manual Paybill payment confirmation flow (landlord/manager side) -
// same requireRole('landlord', 'manager') pattern used everywhere else
// in this file; tenants and every other role get a 403.
router.get('/pending-confirmations', requireRole('landlord', 'manager'), pendingPaymentConfirmationController.getPendingConfirmations);
router.patch(
  '/pending-confirmations/:id/confirm',
  requireRole('landlord', 'manager'),
  requireNotCaretaker('Caretakers cannot confirm payments. Contact the landlord or property manager.'),
  pendingPaymentConfirmationController.confirmPendingPayment
);
router.patch(
  '/pending-confirmations/:id/reject',
  requireRole('landlord', 'manager'),
  requireNotCaretaker('Caretakers cannot reject payments. Contact the landlord or property manager.'),
  pendingPaymentConfirmationController.rejectPendingPayment
);
// Caretakers CAN delete already-actioned (confirmed/rejected) records,
// same as landlords/managers - they just can't confirm/reject in the
// first place (see requireNotCaretaker above on those two routes).
router.delete(
  '/pending-confirmations/:id',
  requireRole('landlord', 'manager'),
  pendingPaymentConfirmationController.deletePendingConfirmation
);

module.exports = router;
