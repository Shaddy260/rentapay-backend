const express = require('express');
const router = express.Router();
const communityController = require('../controllers/community.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const { handleCommunityPhotosUpload } = require('../middleware/upload.middleware');

router.use(verifyToken);

// Board + marketplace posts are readable/postable by tenants,
// landlords, managers, and caretakers - this is the one surface in
// the app that's genuinely peer-to-peer rather than owner-scoped.
// (Caretakers are role='manager'/roleLevel='caretaker', already
// covered by requireRole('manager') - no separate 'caretaker' role
// string exists in this app.)
router.get('/', requireRole('tenant', 'landlord', 'manager'), communityController.listPosts);
router.get('/unread-count', requireRole('tenant', 'landlord', 'manager'), communityController.getUnreadCount);
router.post('/mark-read', requireRole('tenant', 'landlord', 'manager'), communityController.markRead);
// FEATURE (direct request): posts can now attach photos. multipart
// form-data is parsed here (optional - a plain JSON post with no
// files still works); createPost handles both.
router.post('/', requireRole('tenant', 'landlord', 'manager'), handleCommunityPhotosUpload, communityController.createPost);
router.delete('/:postId', requireRole('tenant', 'landlord', 'manager'), communityController.deletePost);
router.post('/:postId/hide', requireRole('tenant', 'landlord', 'manager'), communityController.hidePost);
router.patch('/:postId/pin', requireRole('landlord', 'manager'), communityController.pinPost);

router.post('/:postId/replies', requireRole('tenant', 'landlord', 'manager'), communityController.createReply);
router.delete('/replies/:replyId', requireRole('tenant', 'landlord', 'manager'), communityController.deleteReply);
router.post('/replies/:replyId/hide', requireRole('tenant', 'landlord', 'manager'), communityController.hideReply);

router.post('/report', requireRole('tenant', 'landlord', 'manager'), communityController.reportContent);

module.exports = router;
