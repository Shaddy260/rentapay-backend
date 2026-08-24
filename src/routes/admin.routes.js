const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const announcementController = require('../controllers/announcement.controller');
const credentialsController = require('../controllers/credentials.controller');
const financialOverviewController = require('../controllers/adminFinancialOverview.controller');
const manualSubPaymentController = require('../controllers/landlordManualSubscriptionPayment.controller');
const ratingFlagController = require('../controllers/ratingFlag.controller');
const moderationController = require('../controllers/moderation.controller');
const landlordLeadController = require('../controllers/landlordLead.controller');
const generalManagerController = require('../controllers/generalManager.controller');
const generalManagerLogController = require('../controllers/generalManagerLog.controller');
const generalManagerRevertController = require('../controllers/generalManagerRevert.controller');
const generalManagerReviewController = require('../controllers/generalManagerReview.controller');
const { verifyToken, requireRole, blockGeneralManagerFinancial, requireOperationsPinConfirmation, requireGmPermission } = require('../middleware/auth.middleware');

// SECTION 5 (General Manager spec): a General Manager sees everything
// admin sees on this router - same data, same endpoints - with two
// carve-outs enforced below, not just in the frontend:
//   1. requireOperationsPinConfirmation (SECTION 6) - GM writes now
//      require { operationsPin, reason } in the body, verified
//      server-side against the GM's own Operations PIN before the
//      request reaches any controller below. GETs pass straight
//      through untouched. Admin is completely unaffected either way.
//   2. blockGeneralManagerFinancial - platform financial/profit
//      routes (revenue, growth stats, financial overview, pricing
//      proposal) stay admin-only outright; see that middleware's doc
//      comment for why.
// Admin's own behavior on every route below is completely unchanged.
router.use(verifyToken, requireRole('admin', 'general_manager'), requireOperationsPinConfirmation);

router.get('/dashboard', adminController.getDashboardMetrics);
router.get('/search', adminController.globalSearch);
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
// SECTION 5: revenue/growth/pricing-proposal are exactly the
// "financial breakdown and profit figures" the spec names as the one
// thing hidden from General Managers - blocked outright for that
// role, admin unaffected.
router.get('/revenue', blockGeneralManagerFinancial, adminController.getRevenueBreakdown);
router.get('/revenue-trend', blockGeneralManagerFinancial, adminController.getRevenueTrend);
router.get('/revenue-dashboard', blockGeneralManagerFinancial, adminController.getRevenueDashboard);
router.get('/pricing-proposal', blockGeneralManagerFinancial, adminController.getPricingProposal);

// PREMIUM REDESIGN PLAN - PHASE 9: Admin Financial Overview & Expense
// Tracking. Scoped to one month at a time (?month=YYYY-MM, defaults
// to the current month).
// SECTION 5: operating expenses are explicitly named as hidden
// financial data - blocked for General Managers on every route below.
router.get('/financial-overview', blockGeneralManagerFinancial, financialOverviewController.getOverview);
router.post('/financial-overview/expenses', blockGeneralManagerFinancial, financialOverviewController.addExpense);
router.post('/financial-overview/expenses/:id/stop', blockGeneralManagerFinancial, financialOverviewController.stopExpense);
router.delete('/financial-overview/expenses/:id', blockGeneralManagerFinancial, financialOverviewController.deleteExpense);
router.get('/growth-statistics', blockGeneralManagerFinancial, adminController.getGrowthStatistics);
router.get('/expiring-landlords', adminController.getExpiringLandlords);
router.post('/expiring-landlords/remind', adminController.sendRenewalReminders);
router.patch('/landlords/:landlordId/status', adminController.setLandlordStatus);
router.delete('/landlords/:landlordId', adminController.deleteLandlordAccount);
router.patch('/landlords/:landlordId/subscription', adminController.editLandlordSubscription);
router.get('/landlords/:landlordId/properties', adminController.getLandlordProperties);
// Managers/caretakers share the landlord's dashboard/data model rather
// than having their own admin tab - surfaced nested under their
// landlord (both in the landlords drilldown and via global search
// deep-link) with the same suspend/activate actions as a landlord.
router.get('/landlords/:landlordId/managers', adminController.getLandlordManagers);
router.patch('/managers/:managerId/status', adminController.setManagerStatus);
router.get('/first-time-credentials', credentialsController.listAllFirstTimeCredentialsForAdmin);
router.get('/password-reset-requests', credentialsController.listAllPasswordResetRequestsForAdmin);
router.get('/activity-log', adminController.getActivityLog);
// SECTION 6 (General Manager spec): "editable by General Managers:
// everything else they have visibility into ... any other data
// editing outside the two locked items above" is deliberately read as
// account/platform DATA editing (landlords, tenants, BAs, onboarding,
// activate/suspend). Deleting the audit trail itself, and the
// emergency-lockdown switch, are system/integrity operations rather
// than data edits - and the whole point of Sections 7-10 is admin
// being able to review and revert what a General Manager did, which
// would be undermined by that same role being able to delete the log
// of it. Both stay admin-only, explicitly, on top of the router-wide
// admin+GM gate above.
router.delete('/activity-log/day', requireRole('admin'), adminController.deleteActivityLogsForDay);

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
router.delete('/activity-log/:logId', requireRole('admin'), adminController.deleteActivityLogEntry);
router.get('/lockdown-status', adminController.getLockdownStatus);
router.post('/emergency-lockdown', requireRole('admin'), adminController.emergencyLockdown);
router.post('/resume-lockdown', requireRole('admin'), adminController.resumeFromLockdown);
// SECTION 1 (General Manager spec): the admin "SQL" tab - a table-by-
// table viewer/editor over Supabase - has been removed outright. Raw
// or scoped database access must never be exposed through any UI on
// the platform, for any account type including admin; direct
// database access now only happens at the infra level. See
// adminSql.controller.js in git history if this is ever needed for
// reference - it is intentionally not present in this codebase.

// Platform-wide broadcast (item 5) - every user on the entire platform,
// tagged "RentaPay" everywhere it shows up.
router.post('/announcements/broadcast', announcementController.createPlatformAnnouncement);

// "Landlords manual payment confirmations" queue - the admin-side
// review for landlord/manager/caretaker subscription payments made
// manually to RentaPay's own paybill (see subscription.routes.js's
// /manual-payment for the submission side). Confirm activates the
// account (first payment) or renews it (subsequent); Reject leaves it
// pending action from the landlord; Delete removes the record.
// SECTION 5: these carry subscription payment amounts (platform
// revenue) - kept out of GM's "financial breakdown" exception, same
// as the routes above.
// UPDATED (direct request): every General Manager can now see this
// queue - the GET list is open to any authenticated GM. Only the
// write actions (confirm/reject/delete) require admin to have
// explicitly toggled can_manage_manual_payments on for that specific
// GM (see GeneralManagersPanel.jsx). This intentionally reverses the
// earlier "GM without the flag doesn't get the menu item at all"
// behavior - the mandate now gates the ACTION, not the VISIBILITY.
//
// FIX (direct request): blockGeneralManagerFinancial used to still be
// mounted on ALL FOUR routes below, including the GET, which
// unconditionally 403'd every General Manager regardless of the
// comment above - nobody, granted or not, could ever actually see or
// use this queue. requireGmPermission already gives admin its own
// unrestricted pass-through and blocks an ungranted GM with a clear
// "your admin has not enabled this" message on the write routes, so
// blockGeneralManagerFinancial (meant for the separate profit/revenue
// breakdown, not this queue) is removed from all four here.
router.get('/landlord-manual-subscription-payments', manualSubPaymentController.listManualSubscriptionPayments);
router.post('/landlord-manual-subscription-payments/:id/confirm', requireGmPermission('can_manage_manual_payments'), manualSubPaymentController.confirmManualSubscriptionPayment);
router.post('/landlord-manual-subscription-payments/:id/reject', requireGmPermission('can_manage_manual_payments'), manualSubPaymentController.rejectManualSubscriptionPayment);
router.delete('/landlord-manual-subscription-payments/:id', requireGmPermission('can_manage_manual_payments'), manualSubPaymentController.deleteManualSubscriptionPayment);

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

// SECTION 2 (General Manager spec): admin-only account creation for
// the new General Manager role. No self-signup path, and no other
// role can create one - see generalManager.controller.js.
// Admin-account-management, not platform data - stays admin-only.
// GMs cannot create other GMs (Section 2) and, correspondingly, don't
// get to browse the GM roster either.
router.get('/general-managers', requireRole('admin'), generalManagerController.listGeneralManagers);
router.post('/general-managers', requireRole('admin'), generalManagerController.createGeneralManager);
// Self-service onboarding link (Prompt 7) - same shape as the BA
// onboarding-link routes: admin views/generates the current live
// link here; the invitee's own submission happens on public routes
// registered separately (see generalManager.routes.js).
router.get('/general-managers/onboarding-link', requireRole('admin'), generalManagerController.getGmOnboardingLinkStatus);
router.post('/general-managers/onboarding-link/generate', requireRole('admin'), generalManagerController.generateGmOnboardingLink);
// Pending-approval queue for onboarding-link submissions - admin must
// explicitly approve or reject each one before the account can log
// in. Same pattern as the Brand Ambassador applications queue.
router.get('/general-managers/applications', requireRole('admin'), generalManagerController.listPendingGmApplications);
router.post('/general-managers/:id/approve', requireRole('admin'), generalManagerController.approveGmApplication);
router.post('/general-managers/:id/reject', requireRole('admin'), generalManagerController.rejectGmApplication);
// Suspend / reactivate a General Manager's own account - admin-only,
// same reasoning as the roster/creation routes above (a General
// Manager can never manage another General Manager's account).
router.patch('/general-managers/:id/status', requireRole('admin'), generalManagerController.setGeneralManagerStatus);
router.patch('/general-managers/:id/permissions', requireRole('admin'), generalManagerController.updateGmPermissions);

// SECTION 8 (General Manager spec) - admin browsing a specific
// General Manager's own dedicated log page (day/week/month views).
// Admin-only, same as the roster above - a General Manager cannot
// browse another General Manager's history, only their own (see
// generalManager.routes.js's /my-logs for that).
router.get('/general-managers/:id/logs', requireRole('admin'), generalManagerLogController.getManagerLogsForAdmin);

// SECTION 9 (General Manager spec) - styled, branded PDF export of a
// specific General Manager's activity log, filtered to an optional
// ?from=YYYY-MM-DD&to=YYYY-MM-DD range. Admin-only, same as the log
// page itself above. Placed as its own sub-route (not a query param
// on the JSON endpoint above) so it can set PDF response headers
// cleanly - see generalManagerLog.controller.js.
router.get('/general-managers/:id/logs/export.pdf', requireRole('admin'), generalManagerLogController.exportManagerLogsPdf);

// SECTION 10 (General Manager spec) — Admin Revert Capability.
// "From under each General Manager's account card/profile, admin has
// a revert capability" — individual (one log entry) or bulk (every
// eligible, not-yet-reverted entry in a date range). Admin-only, same
// gate as the log page and PDF export above. A General Manager never
// gets this affordance for their own history — see
// generalManagerRevert.controller.js's header note.
router.post('/general-managers/:id/logs/:logId/revert', requireRole('admin'), generalManagerRevertController.revertSingleLog);
router.post('/general-managers/:id/logs/revert-range', requireRole('admin'), generalManagerRevertController.revertRange);

// ADMIN CONFIRMATION QUEUE (direct request) — every sensitive GM
// action (same set Section 10 marks is_revertible) lands here for
// admin to confirm or reject, on top of the GM's own Operations-PIN
// confirmation. Listed across ALL managers (not scoped to one :id
// like the routes above) so it can power a single dedicated admin-
// portal page + incoming-items banner. Admin-only; a General Manager
// never sees this queue. Confirm/reject one-by-one, a checkbox-
// selected batch, or everything pending at once — see
// generalManagerReview.controller.js.
router.get('/general-managers/pending-reviews', requireRole('admin'), generalManagerReviewController.listPending);
router.get('/general-managers/pending-reviews/count', requireRole('admin'), generalManagerReviewController.getPendingCount);
router.post('/general-managers/pending-reviews/bulk-review', requireRole('admin'), generalManagerReviewController.reviewBulk);
router.post('/general-managers/pending-reviews/:logId/review', requireRole('admin'), generalManagerReviewController.reviewOne);

module.exports = router;
