const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboard.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);
router.get('/', requireRole('landlord', 'manager'), dashboardController.getLandlordDashboard);
router.get('/statistics', requireRole('landlord', 'manager'), dashboardController.getLandlordStatistics);
router.get('/statistics/pdf', requireRole('landlord', 'manager'), dashboardController.getLandlordStatisticsPdf);
router.get('/payments-this-month', requireRole('landlord', 'manager'), dashboardController.getPaymentsThisMonth);
router.get('/attention', requireRole('landlord', 'manager'), dashboardController.getAttentionFeed);
router.get('/due-dates', requireRole('landlord', 'manager'), dashboardController.getDueDatesCalendar);
router.get('/search', requireRole('landlord', 'manager'), dashboardController.globalSearch);
router.get('/:landlordId', requireRole('admin'), dashboardController.getLandlordDashboard);
router.get('/:landlordId/statistics', requireRole('admin'), dashboardController.getLandlordStatistics);

module.exports = router;
