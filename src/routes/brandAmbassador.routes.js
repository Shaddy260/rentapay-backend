const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/brandAmbassador.controller');
const payoutRulesCtrl = require('../controllers/payoutRules.controller');
const baAdminPayoutCtrl = require('../controllers/baAdminPayout.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

// PUBLIC - the one generic "Become a Brand Ambassador" link
// (frontend: /become-a-ba). No token in the URL, no login.
router.post('/email/send-otp', ctrl.requestBaEmailVerification);
router.post('/email/verify-otp', ctrl.confirmBaEmailVerification);
router.post('/apply', ctrl.submitBaOnboarding);
// PUBLIC - the /become-a-ba page calls this on load to check whether
// its ?token= is still good before letting the applicant start
// filling in the form (24h-rotating link, see brandAmbassador.controller.js).
router.get('/onboarding-link/validate', ctrl.validateBaOnboardingLinkToken);
// PHASE 4 - public referral-code resolution for the landlord signup form.
router.get('/referral/:code', ctrl.resolveReferralCode);

// BA-ONLY - the logged-in BA's own portal shell (Phase 3). Scoped
// server-side to req.user.id, never a client-supplied id.
router.get('/me', verifyToken, requireRole('brand_ambassador'), ctrl.getMyBaProfile);
// PHASE 6 - Settings & Profile: contact-detail edits and the
// leaderboard opt-in toggle. Password change reuses the existing
// generic /api/auth/change-password route (already includes
// 'brand_ambassador' in its requireRole list); profile photo upload
// reuses the existing generic /api/upload/profile-photo route below.
router.patch('/me', verifyToken, requireRole('brand_ambassador'), ctrl.updateMyProfile);
router.patch('/me/leaderboard-opt-in', verifyToken, requireRole('brand_ambassador'), ctrl.updateLeaderboardOptIn);
// SECTION A/B: manual claim logging (submit/list/edit) has been
// removed entirely - a landlord is attached to a BA only via the
// referral link/code at signup. "My Onboarded Landlords" is now the
// ONE single live list, sourced directly from landlords.ba_id.
router.get('/landlords/mine', verifyToken, requireRole('brand_ambassador'), ctrl.listMyOnboardedLandlords);
// PHASE 7 - "Share with admin": builds a report summary from the live
// onboarded-landlords list and posts it to the admin notifications
// inbox; returns the same text so the frontend can also open a wa.me
// deep link with it.
router.post('/landlords/mine/share', verifyToken, requireRole('brand_ambassador'), ctrl.shareClaimsReport);
// PHASE 5 - BA dashboard/stats aggregates. Scoped server-side to
// req.user.id, never a client-supplied BA id.
router.get('/stats/mine', verifyToken, requireRole('brand_ambassador'), ctrl.getBaStats);
// SECTION E - the BA's own recurring commission earnings list
// (ba_commission_earnings), one row per completed landlord
// subscription payment. Scoped server-side to req.user.id.
router.get('/earnings/mine', verifyToken, requireRole('brand_ambassador'), ctrl.getMyCommissionEarnings);
// PHASE 18 - Optional BA Leaderboard. BA-authenticated; opt-in filter
// and the caller's own exact rank are both computed server-side, see
// getLeaderboard for exactly what is and isn't exposed.
router.get('/leaderboard', verifyToken, requireRole('brand_ambassador'), ctrl.getLeaderboard);
// PHASE 17 - the BA's own downloadable earnings statement. Scoped
// server-side to req.user.id (no :baId in the path), same pattern as
// /stats/mine above.
router.get('/me/earnings-statement', verifyToken, requireRole('brand_ambassador'), baAdminPayoutCtrl.getBaEarningsStatement);
router.get('/me/earnings-statement.pdf', verifyToken, requireRole('brand_ambassador'), baAdminPayoutCtrl.downloadBaEarningsStatementPdf);
router.get('/me/earnings-statement.csv', verifyToken, requireRole('brand_ambassador'), baAdminPayoutCtrl.downloadBaEarningsStatementCsv);

// ADMIN-ONLY - everything else.
// The rotating 24h onboarding link - admin generates/regenerates it
// here and shares it manually (copy/WhatsApp); the old token dies the
// instant a new one is generated, and it also dies 24h after
// generation on its own either way.
router.get('/onboarding-link', verifyToken, requireRole('admin'), ctrl.getBaOnboardingLinkStatus);
router.post('/onboarding-link/generate', verifyToken, requireRole('admin'), ctrl.generateBaOnboardingLink);
router.get('/applications', verifyToken, requireRole('admin'), ctrl.listPendingBaApplications);
router.post('/applications/:id/approve', verifyToken, requireRole('admin'), ctrl.approveBaApplication);
router.post('/applications/:id/reject', verifyToken, requireRole('admin'), ctrl.rejectBaApplication);
router.get('/', verifyToken, requireRole('admin'), ctrl.listBrandAmbassadors);
// PHASE 16 - suspend (reversible, for-cause) vs offboard (permanent,
// referral link keeps working) are deliberately separate actions -
// see brandAmbassador.controller.js for what each one does and does
// not touch.
router.post('/:id/suspend', verifyToken, requireRole('admin'), ctrl.suspendBrandAmbassador);
router.post('/:id/reactivate', verifyToken, requireRole('admin'), ctrl.reactivateBrandAmbassador);
router.post('/:id/offboard', verifyToken, requireRole('admin'), ctrl.offboardBrandAmbassador);
router.post('/:id/restore', verifyToken, requireRole('admin'), ctrl.restoreBrandAmbassador);

// SECTION E - percentage commission rate (global + per-BA override),
// each an append-only history (setting a new rate inserts a new row
// rather than overwriting the current one). Nested under
// /brand-ambassadors since payout_rules is always scoped to this
// feature, mirroring how claims/stats above are nested rather than
// living at the API root. The old commission-tiers / unit-pricing-tiers
// endpoints that used to live here are gone - hard cutover, those
// tables no longer exist.
router.get('/payout-rules', verifyToken, requireRole('admin'), payoutRulesCtrl.getPayoutRules);
router.patch('/payout-rules/global', verifyToken, requireRole('admin'), payoutRulesCtrl.updateGlobalPayoutRule);
router.patch('/:baId/payout-rule-override', verifyToken, requireRole('admin'), payoutRulesCtrl.setBaPayoutOverride);
router.get('/payout-rules/history', verifyToken, requireRole('admin'), payoutRulesCtrl.getPayoutRuleHistory);

// PHASE 19 - Qualification Job Dry-Run Mode. Admin-triggered manual
// run, alongside the Phase 10 Payout Rules screen - side-effect-free,
// safe to call as often as needed (e.g. right after a rate/tier
// change) without touching the live scheduled job.
router.post('/qualification/dry-run', verifyToken, requireRole('admin'), payoutRulesCtrl.runQualificationDryRun);
router.post('/qualification/run-now', verifyToken, requireRole('admin'), payoutRulesCtrl.runQualificationNow);
router.get('/qualification/dry-run.csv', verifyToken, requireRole('admin'), payoutRulesCtrl.downloadQualificationDryRunCsv);

// PHASE 11 - Admin: Payout Review, Reconciliation & Cross-BA Security
// Report. Part A/B routes are nested under a BA id where the action is
// scoped to one BA (mark paid/not-paid, statement download); the
// review list itself and the security report are standing/period
// reads with no single-BA path.
router.get('/payout-review', verifyToken, requireRole('admin'), baAdminPayoutCtrl.getPayoutReview);
router.post('/:baId/payout-review/mark-paid', verifyToken, requireRole('admin'), baAdminPayoutCtrl.markBaPeriodPaid);
router.post('/:baId/payout-review/mark-not-paid', verifyToken, requireRole('admin'), baAdminPayoutCtrl.markBaPeriodNotPaid);
router.get('/:baId/payout-statement.csv', verifyToken, requireRole('admin'), baAdminPayoutCtrl.downloadBaPayoutStatement);
router.post('/reconcile', verifyToken, requireRole('admin'), baAdminPayoutCtrl.reconcileBaList);
router.get('/security-report', verifyToken, requireRole('admin'), baAdminPayoutCtrl.getBaSecurityReport);

// PHASE 17 - Downloadable Earnings Statement. Admin variant of the
// /me/earnings-statement routes above - same handlers, :baId taken
// from the path instead of the token.
router.get('/:baId/earnings-statement', verifyToken, requireRole('admin'), baAdminPayoutCtrl.getBaEarningsStatement);
router.get('/:baId/earnings-statement.pdf', verifyToken, requireRole('admin'), baAdminPayoutCtrl.downloadBaEarningsStatementPdf);
router.get('/:baId/earnings-statement.csv', verifyToken, requireRole('admin'), baAdminPayoutCtrl.downloadBaEarningsStatementCsv);

module.exports = router;
