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

// Registration-time manual payment fallback (direct request - see
// landlordManualSubscriptionPayment.controller.js for the full why).
// Public for the same reason as the STK poll right above: no JWT
// exists yet at this point in the signup flow.
const manualSubPaymentControllerForRegistration = require('../controllers/landlordManualSubscriptionPayment.controller');
router.post('/subscription-manual/register', paybillSubmitLimiter, manualSubPaymentControllerForRegistration.submitRegistrationManualPayment);
router.get('/subscription-manual/register/:landlordId/status', manualSubPaymentControllerForRegistration.checkRegistrationManualPaymentStatus);

router.use(verifyToken);
// Caretaker restriction (Role Permissions spec, Section 3): Payment
// History is in the caretaker's "no access at all, not even
// read-only" list.
router.get('/history', requireRole('landlord', 'manager'), requireNotCaretaker('Caretakers cannot view payment history. Contact the landlord or property manager.'), paymentController.getLandlordPaymentHistory);
router.delete('/history/:paymentId', requireRole('landlord', 'manager'), requireNotCaretaker('Caretakers cannot delete payment records. Contact the landlord or property manager.'), paymentController.deletePayment);
router.get('/history/:landlordId', requireRole('admin'), paymentController.getLandlordPaymentHistory);
router.post('/stk-push', requireRole('tenant'), paymentController.initiateRentSTKPush);
router.get('/rent-status/:checkoutRequestId', requireRole('tenant'), paymentController.checkRentPaymentStatus);
router.post('/paybill-submit', requireRole('tenant'), paybillSubmitLimiter, paymentController.submitPaybillTransaction);
router.get('/my-latest-confirmation', requireRole('tenant'), paymentController.getMyLatestPaybillConfirmation);
// Section 6: tenant, landlord, and manager can all manually download a
// single receipt - the controller itself checks ownership per role.
router.get('/:paymentId/receipt', requireRole('tenant', 'landlord', 'manager'), paymentController.downloadReceiptPdf);
// DIRECT REQUEST: landlord/manager/caretaker bulk "download all
// receipts" for record-keeping. Optional ?propertyId=&from=&to=.
router.get('/receipts/bulk-download', requireRole('landlord', 'manager'), paymentController.downloadAllReceiptsZip);
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
// Multi-select "Delete selected" / "Delete all" (spec: Pending Payment
// Confirmations Card) - same caretaker-allowed shape as the
// single-record delete above, POST since it takes a body (ids array
// or an "all" flag) rather than a single :id param.
router.post(
  '/pending-confirmations/bulk-delete',
  requireRole('landlord', 'manager'),
  pendingPaymentConfirmationController.bulkDeletePendingConfirmations
);

module.exports = router;
