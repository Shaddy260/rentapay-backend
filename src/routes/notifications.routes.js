const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notifications.controller');
const { verifyToken } = require('../middleware/auth.middleware');

router.use(verifyToken);

router.get('/', notificationsController.listNotifications);
router.post('/:notificationId/read', notificationsController.markRead);
router.post('/read-all', notificationsController.markAllRead);

// Replaces the old read/read-all flow in the bell UI: tapping a
// notification (or "Read all") now deletes it for this recipient
// only, rather than just flagging it read.
router.delete('/:notificationId', notificationsController.deleteNotification);
router.delete('/', notificationsController.deleteAllNotifications);

module.exports = router;
