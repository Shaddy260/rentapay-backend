const express = require('express');
const router = express.Router();
const subController = require('../controllers/subscription.controller');
const manualController = require('../controllers/landlordManualSubscriptionPayment.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);

// UPDATED (Role Permissions spec, Section 3 - "Manage Subscription
// access clarification"): the spec's own bullet list initially names
// Manage Subscription as something caretakers should NOT have access
// to, but then explicitly clarifies "Both Manager and Caretaker
// retain access to Manage Subscription - this is not restricted. The
// only Caretaker restrictions are the items explicitly listed above."
// That clarification is the more specific, deliberate statement, so
// the prior requireNotCaretaker gate here has been removed - caretakers
// now have the same subscription access as managers/landlords. Flagging
// this contradiction: if the bullet-list restriction was actually the
// intended behavior, this is a one-line revert (re-add
// requireNotCaretaker(...) to both routes below).
router.post('/renew', requireRole('landlord', 'manager'), subController.renewSubscription);
router.post('/add-units', requireRole('landlord', 'manager'), subController.addUnitsMidPeriod);
router.get('/status', requireRole('landlord', 'manager'), subController.getSubscriptionStatus);
router.get('/status/:landlordId', requireRole('admin'), subController.getSubscriptionStatus);

// "Didn't receive the popup? Pay manually" fallback - direct request
// that this should work for the landlord OR any of their subordinates
// (manager/caretaker), unlike the STK-initiating routes above which
// intentionally stay landlord/manager-only. req.user.role is
// 'manager' for caretakers too (roleLevel distinguishes them), so
// requireRole('landlord', 'manager') already covers both.
router.post('/manual-payment', requireRole('landlord', 'manager'), manualController.submitManualSubscriptionPayment);
router.get('/manual-payment/mine', requireRole('landlord', 'manager'), manualController.getMyLatestManualSubscriptionPayment);

module.exports = router;
