const express = require('express');
const router = express.Router();
const subController = require('../controllers/subscription.controller');
const manualController = require('../controllers/landlordManualSubscriptionPayment.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');

router.use(verifyToken);

// FIX (item: "managers should be able to manage subscription just
// like landlords, but caretakers not"): property managers now share
// the landlord's subscription access; caretakers are explicitly
// blocked with a clear message rather than a generic 403.
router.post('/renew', requireRole('landlord', 'manager'), requireNotCaretaker('Caretakers cannot manage the subscription. Contact the landlord or property manager.'), subController.renewSubscription);
router.post('/add-units', requireRole('landlord', 'manager'), requireNotCaretaker('Caretakers cannot manage the subscription. Contact the landlord or property manager.'), subController.addUnitsMidPeriod);
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
