const express = require('express');
const router = express.Router();
const disputeController = require('../controllers/dispute.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// "Dispute a charge" - available to tenant, landlord, and manager
// accounts (an admin can still read via listDisputes' landlordId/
// tenantId filters, but doesn't raise or resolve disputes itself -
// that's between the landlord and tenant, same as chat).
router.use(verifyToken);

router.post('/', disputeController.createDispute);
router.get('/', disputeController.listDisputes);
router.patch('/:disputeId/resolve', disputeController.resolveDispute);

module.exports = router;
