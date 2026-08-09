const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboard.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');

router.use(verifyToken);
router.get('/', requireRole('landlord', 'manager'), dashboardController.getLandlordDashboard);
// Caretaker restriction (Role Permissions spec, Section 3): Financial
// Statistics is in the caretaker's "no access at all, not even
// read-only" list - blocked at the route level, not just hidden in
// the sidebar (see requireNotCaretaker's doc comment for why).
router.get('/statistics', requireRole('landlord', 'manager'), requireNotCaretaker('Caretakers cannot view financial statistics. Contact the landlord or property manager.'), dashboardController.getLandlordStatistics);
router.get('/statistics/pdf', requireRole('landlord', 'manager'), requireNotCaretaker('Caretakers cannot view financial statistics. Contact the landlord or property manager.'), dashboardController.getLandlordStatisticsPdf);
router.get('/payments-this-month', requireRole('landlord', 'manager'), dashboardController.getPaymentsThisMonth);
router.get('/attention', requireRole('landlord', 'manager'), dashboardController.getAttentionFeed);
router.get('/due-dates', requireRole('landlord', 'manager'), dashboardController.getDueDatesCalendar);
router.get('/search', requireRole('landlord', 'manager'), dashboardController.globalSearch);
router.get('/:landlordId', requireRole('admin'), dashboardController.getLandlordDashboard);
router.get('/:landlordId/statistics', requireRole('admin'), dashboardController.getLandlordStatistics);

module.exports = router;
