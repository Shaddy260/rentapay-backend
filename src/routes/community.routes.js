const express = require('express');
const router = express.Router();
const communityController = require('../controllers/community.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);

// Board + marketplace posts are readable/postable by tenants,
// landlords, managers, and caretakers - this is the one surface in
// the app that's genuinely peer-to-peer rather than owner-scoped.
router.get('/', requireRole('tenant', 'landlord', 'manager'), communityController.listPosts);
router.post('/', requireRole('tenant', 'landlord', 'manager'), communityController.createPost);
router.delete('/:postId', requireRole('tenant', 'landlord', 'manager'), communityController.deletePost);
router.patch('/:postId/pin', requireRole('landlord', 'manager'), communityController.pinPost);

router.post('/:postId/replies', requireRole('tenant', 'landlord', 'manager'), communityController.createReply);
router.delete('/replies/:replyId', requireRole('tenant', 'landlord', 'manager'), communityController.deleteReply);

module.exports = router;
