const express = require('express');
const router = express.Router();
const assistantController = require('../controllers/assistant.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);

// Every logged-in role that has its own dashboard/sidebar walkthrough
// (landlord, manager/caretaker, tenant) may check/update its own
// status. Admin isn't part of this feature (spec covers the four
// landlord/manager/caretaker/tenant roles only).
router.get('/status', requireRole('landlord', 'manager', 'tenant'), assistantController.getStatus);
router.post('/seen', requireRole('landlord', 'manager', 'tenant'), assistantController.markSeen);

module.exports = router;
