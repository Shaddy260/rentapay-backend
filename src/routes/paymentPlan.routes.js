const express = require('express');
const router = express.Router();
const paymentPlanController = require('../controllers/paymentPlan.controller');
const { verifyToken, requireNotCaretaker } = require('../middleware/auth.middleware');

// In-app rent negotiation / payment plan requests - tenant, landlord,
// and manager accounts only (same access shape as disputes).
router.use(verifyToken);

// Caretaker restriction (Role Permissions spec, Section 3): Payment
// Plan Requests is in the caretaker's "no access at all, not even
// read-only" list - blocks GET too, not just decide/cancel.
router.use(requireNotCaretaker('Caretakers cannot access payment plan requests. Contact the landlord or property manager.'));

router.post('/', paymentPlanController.createRequest);
router.get('/', paymentPlanController.listRequests);
router.patch('/:requestId/decide', paymentPlanController.decideRequest);
router.patch('/:requestId/cancel', paymentPlanController.cancelRequest);
// FEATURE (spec item 4): long-press-to-delete a single installment on
// the tenant's own approved plan.
router.delete('/:requestId/installments/:index', paymentPlanController.deleteInstallment);

module.exports = router;
