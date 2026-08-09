const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// All chat endpoints require a logged-in account - this is the
// "chat with an agent" / "text your landlord/tenant" system for
// admins, landlords, and tenants who already have an account (guests
// without an account still use the pre-login Help form in help.routes.js).
router.use(verifyToken);

router.get('/threads', chatController.listThreads);
router.get('/messages', chatController.listMessages);
router.post('/messages', chatController.sendMessage);
router.delete('/messages/:messageId', chatController.deleteMessage);

module.exports = router;
