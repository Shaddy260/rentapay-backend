const express = require('express');
const router = express.Router();
const controller = require('../controllers/supportChat.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);

router.post('/message', controller.sendMessage);
router.post('/menu-select', controller.selectMenuOption);
router.post('/escalate', controller.escalateToAgent);
router.post('/rating', controller.submitRating);
router.get('/pending-rating', controller.getPendingRating);
router.get('/history', controller.getHistory);

// Section 8 - admin-only Support Analytics view.
router.get('/analytics', requireRole('admin'), controller.getAnalytics);

module.exports = router;
