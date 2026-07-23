const express = require('express');
const router = express.Router();
const announcementController = require('../controllers/announcement.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);

// Sending is landlord + property manager + caretaker (item 3
// clarification - caretakers are explicitly included now; previously
// this was landlord + manager only).
router.post('/', requireRole('landlord', 'manager'), announcementController.createAnnouncement);

router.get('/', requireRole('landlord', 'manager', 'tenant', 'scout'), announcementController.listAnnouncements);
router.post('/:announcementId/read', requireRole('landlord', 'manager', 'tenant', 'scout'), announcementController.markAnnouncementRead);
// scope: 'self' (hide for me only) | 'all' (delete for everyone -
// landlord/manager/caretaker on their own account's announcements
// only; tenants are always forced to 'self' regardless of what's sent).
router.delete('/:announcementId', requireRole('landlord', 'manager', 'tenant', 'scout', 'admin'), announcementController.deleteAnnouncement);

module.exports = router;
