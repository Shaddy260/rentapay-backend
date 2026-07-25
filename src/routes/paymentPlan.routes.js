const express = require('express');
const router = express.Router();
const paymentPlanController = require('../controllers/paymentPlan.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// In-app rent negotiation / payment plan requests - tenant, landlord,
// and manager accounts only (same access shape as disputes).
router.use(verifyToken);

router.post('/', paymentPlanController.createRequest);
router.get('/', paymentPlanController.listRequests);
router.patch('/:requestId/decide', paymentPlanController.decideRequest);
router.patch('/:requestId/cancel', paymentPlanController.cancelRequest);

module.exports = router;
