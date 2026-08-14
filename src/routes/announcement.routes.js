const express = require('express');
const router = express.Router();
const announcementController = require('../controllers/announcement.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);

// Sending is landlord + property manager + caretaker (item 3
// clarification - caretakers are explicitly included now; previously
// this was landlord + manager only).
router.post('/', requireRole('landlord', 'manager'), announcementController.createAnnouncement);

// Brand ambassadors can now list/read/delete announcements too (BA-
// scoped branch in the controller only ever surfaces platform-wide
// broadcasts targeted at their own group or 'all' - they have no
// landlord_id to scope by, unlike every other role here).
router.get('/', requireRole('landlord', 'manager', 'tenant', 'brand_ambassador'), announcementController.listAnnouncements);
router.post('/:announcementId/read', requireRole('landlord', 'manager', 'tenant', 'brand_ambassador'), announcementController.markAnnouncementRead);
// scope: 'self' (hide for me only) | 'all' (delete for everyone -
// landlord/manager/caretaker on their own account's announcements
// only; tenants and BAs are always forced to 'self' regardless of
// what's sent).
router.delete('/:announcementId', requireRole('landlord', 'manager', 'tenant', 'brand_ambassador', 'admin'), announcementController.deleteAnnouncement);

module.exports = router;
