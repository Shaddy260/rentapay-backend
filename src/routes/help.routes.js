const express = require('express');
const router = express.Router();
const helpController = require('../controllers/help.controller');
const { verifyToken, optionalAuth, requireRole } = require('../middleware/auth.middleware');

// Help form must work for people who aren't logged in yet (blueprint 15:
// "help before logging in" - see Login.jsx), so it uses optionalAuth
// instead of the strict verifyToken the rest of this router uses.
router.post('/', optionalAuth, helpController.submitHelpRequest);
router.use(verifyToken);
router.get('/mine', helpController.listMyHelpRequests);
router.get('/', requireRole('admin'), helpController.listHelpRequests);
router.get('/:requestId/reply-thread', requireRole('admin'), helpController.getReplyThread);
router.patch('/:requestId/resolve', requireRole('admin'), helpController.resolveHelpRequest);
router.delete('/:requestId', requireRole('admin'), helpController.deleteHelpRequest);

module.exports = router;
