const express = require('express');
const router = express.Router();
const credentialsController = require('../controllers/credentials.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);

router.get('/', requireRole('landlord', 'manager'), credentialsController.listFirstTimeCredentials);
router.get('/password-reset-requests', requireRole('landlord'), credentialsController.listPasswordResetRequests);

module.exports = router;
