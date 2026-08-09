const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const announcementController = require('../controllers/announcement.controller');
const credentialsController = require('../controllers/credentials.controller');
const adminSqlController = require('../controllers/adminSql.controller');
const manualSubPaymentController = require('../controllers/landlordManualSubscriptionPayment.controller');
const ratingFlagController = require('../controllers/ratingFlag.controller');
const moderationController = require('../controllers/moderation.controller');
const landlordLeadController = require('../controllers/landlordLead.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken, requireRole('admin'));

router.get('/dashboard', adminController.getDashboardMetrics);
router.get('/landlords', adminController.listAllLandlords);
// FEATURE (spec item 10): landlords who started but never finished
// the registration/setup wizard, with which step they stopped at.
router.get('/landlords/incomplete-signups', adminController.getIncompleteSignups);
// PHASE 8 - real landlord signups (system of record) by date/range,
// with "via <BA>" attribution where present. Distinct from the BA
// roster's own self-reported claims tab above.
router.get('/landlords-onboarded', adminController.listLandlordsOnboarded);
router.get('/tenants', adminController.listAllTenants);
router.get('/units', adminController.listAllUnits);
router.get('/revenue', adminController.getRevenueBreakdown);
router.get('/revenue-trend', adminController.getRevenueTrend);
router.get('/revenue-dashboard', adminController.getRevenueDashboard);
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

// FEATURE (direct request): "Reported accounts" - warn/suspend
// (permanent or temporary)/unsuspend, and the accompanying report
// review list.
router.get('/moderation/reports', moderationController.listReports);
router.get('/moderation/accounts', moderationController.listModeratedAccounts);
router.get('/moderation/:accountType/:accountId/history', moderationController.getModerationHistory);
router.post('/moderation/:accountType/:accountId/warn', moderationController.warnAccount);
router.post('/moderation/:accountType/:accountId/suspend', moderationController.suspendAccountPermanently);
router.post('/moderation/:accountType/:accountId/suspend-temporary', moderationController.suspendAccountTemporarily);
router.post('/moderation/:accountType/:accountId/unsuspend', moderationController.unsuspendAccount);
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

// Rating flag review queue (see sql/add-rating-flag-for-review.sql and
// ratingFlag.controller.js): a landlord flags a rating as bad-faith,
// admin resolves it here as either 'upheld' (rating stands, counts
// again) or 'removed' (confirmed bad-faith, stays excluded).
router.get('/rating-flags', ratingFlagController.listFlaggedRatings);
router.patch('/rating-flags/:table/:id/resolve', ratingFlagController.resolveRatingFlag);

// PHASE 9 - marketing landlord-lead review: listing (paginated,
// filterable by status/date) plus the manual "mark contacted" action.
// Auto-conversion itself happens in auth.controller.js's
// registerLandlord - see landlordLead.controller.js.
router.get('/landlord-leads', landlordLeadController.listLandlordLeads);
router.post('/landlord-leads/:id/mark-contacted', landlordLeadController.markLeadContacted);

module.exports = router;
