const express = require('express');
const router = express.Router();
const disputeController = require('../controllers/dispute.controller');
const { verifyToken, requireNotCaretaker } = require('../middleware/auth.middleware');

// "Dispute a charge" - available to tenant, landlord, and manager
// accounts (an admin can still read via listDisputes' landlordId/
// tenantId filters, but doesn't raise or resolve disputes itself -
// that's between the landlord and tenant, same as chat).
router.use(verifyToken);

// Caretaker restriction (Role Permissions spec, Section 3): Disputed
// Charges is in the caretaker's "no access at all, not even
// read-only" list - blocks GET too, not just the write actions.
router.use(requireNotCaretaker('Caretakers cannot access disputed charges. Contact the landlord or property manager.'));

router.post('/', disputeController.createDispute);
router.get('/', disputeController.listDisputes);
router.patch('/:disputeId/resolve', disputeController.resolveDispute);

module.exports = router;
