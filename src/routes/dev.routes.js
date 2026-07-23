// src/routes/dev.routes.js
//
// DEVELOPMENT-ONLY routes. Mounted in server.js only when
// NODE_ENV !== 'production' - see the guard there. Never exposed in
// a production deployment.

const express = require('express');
const router = express.Router();
const devController = require('../controllers/dev.controller');

router.post('/simulate-payment-success', devController.simulatePaymentSuccess);
router.post('/run-billing', devController.runBillingNow);

module.exports = router;
