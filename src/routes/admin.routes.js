const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const announcementController = require('../controllers/announcement.controller');
const credentialsController = require('../controllers/credentials.controller');
const adminSqlController = require('../controllers/adminSql.controller');
const manualSubPaymentController = require('../controllers/landlordManualSubscriptionPayment.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken, requireRole('admin'));

router.get('/dashboard', adminController.getDashboardMetrics);
router.get('/landlords', adminController.listAllLandlords);
router.get('/scouts', adminController.listAllScouts);
router.patch('/scouts/:scoutId/status', adminController.setScoutStatus);
router.get('/tenants', adminController.listAllTenants);
router.get('/units', adminController.listAllUnits);
router.get('/revenue', adminController.getRevenueBreakdown);
router.get('/revenue-trend', adminController.getRevenueTrend);
router.get('/growth-statistics', adminController.getGrowthStatistics);
router.get('/expiring-landlords', adminController.getExpiringLandlords);
router.post('/expiring-landlords/remind', adminController.sendRenewalReminders);
router.patch('/landlords/:landlordId/status', adminController.setLandlordStatus);
router.delete('/landlords/:landlordId', adminController.deleteLandlordAccount);
router.patch('/landlords/:landlordId/subscription', adminController.editLandlordSubscription);
router.get('/landlords/:landlordId/properties', adminController.getLandlordProperties);
router.get('/first-time-credentials', credentialsController.listAllFirstTimeCredentialsForAdmin);
router.get('/password-reset-requests', credentialsController.listAllPasswordResetRequestsForAdmin);
router.get('/activity-log', adminController.getActivityLog);
router.delete('/activity-log/day', adminController.deleteActivityLogsForDay);
router.delete('/activity-log/:logId', adminController.deleteActivityLogEntry);
router.get('/lockdown-status', adminController.getLockdownStatus);
router.post('/emergency-lockdown', adminController.emergencyLockdown);
router.post('/resume-lockdown', adminController.resumeFromLockdown);
// Admin "SQL" tab (item C) - safe table-by-table viewer/editor over a
// whitelisted set of tables (see adminSql.controller.js for why this
// isn't a raw SQL execution box).
router.get('/sql/tables', adminSqlController.listTables);
router.get('/sql/:table', adminSqlController.listRows);
router.patch('/sql/:table/:id', adminSqlController.updateRow);

// Platform-wide broadcast (item 5) - every user on the entire platform,
// tagged "RentaPay" everywhere it shows up.
router.post('/announcements/broadcast', announcementController.createPlatformAnnouncement);

// "Landlords manual payment confirmations" queue - the admin-side
// review for landlord/manager/caretaker subscription payments made
// manually to RentaPay's own paybill (see subscription.routes.js's
// /manual-payment for the submission side). Confirm activates the
// account (first payment) or renews it (subsequent); Reject leaves it
// pending action from the landlord; Delete removes the record.
router.get('/landlord-manual-subscription-payments', manualSubPaymentController.listManualSubscriptionPayments);
router.post('/landlord-manual-subscription-payments/:id/confirm', manualSubPaymentController.confirmManualSubscriptionPayment);
router.post('/landlord-manual-subscription-payments/:id/reject', manualSubPaymentController.rejectManualSubscriptionPayment);
router.delete('/landlord-manual-subscription-payments/:id', manualSubPaymentController.deleteManualSubscriptionPayment);

module.exports = router;
