const express = require('express');
const router = express.Router();
const helpController = require('../controllers/help.controller');
const { verifyToken, optionalAuth, requireRole, requireGmPermission } = require('../middleware/auth.middleware');

// Help form must work for people who aren't logged in yet (blueprint 15:
// "help before logging in" - see Login.jsx), so it uses optionalAuth
// instead of the strict verifyToken the rest of this router uses.
router.post('/', optionalAuth, helpController.submitHelpRequest);
router.use(verifyToken);
router.get('/mine', helpController.listMyHelpRequests);
// FIX (direct request): a General Manager can always SEE incoming
// help requests - purely so they can notice and nudge admin if one's
// been sitting unresolved, same "visibility isn't the same as the
// mandate to act" split already used for manual payments above.
// Resolving/deleting one, and reading the reply thread, still needs
// admin to have explicitly granted can_manage_help_requests to that
// specific GM (see GeneralManagersPanel.jsx / requireGmPermission -
// admin itself always passes straight through, untouched).
router.get('/', requireRole('admin', 'general_manager'), helpController.listHelpRequests);
router.get('/:requestId/reply-thread', requireRole('admin', 'general_manager'), requireGmPermission('can_manage_help_requests'), helpController.getReplyThread);
router.patch('/:requestId/resolve', requireRole('admin', 'general_manager'), requireGmPermission('can_manage_help_requests'), helpController.resolveHelpRequest);
router.delete('/:requestId', requireRole('admin', 'general_manager'), requireGmPermission('can_manage_help_requests'), helpController.deleteHelpRequest);

module.exports = router;
