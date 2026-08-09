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
// PHASE 4 - BA logs/edits/lists their own landlord claims.
router.post('/claims', verifyToken, requireRole('brand_ambassador'), ctrl.submitLandlordClaim);
router.get('/claims/mine', verifyToken, requireRole('brand_ambassador'), ctrl.listMyClaims);
router.patch('/claims/:id', verifyToken, requireRole('brand_ambassador'), ctrl.editMyClaim);
// PHASE 7 - "Share with admin": builds the claims-report summary and
// posts it to the admin notifications inbox; returns the same text so
// the frontend can also open a wa.me deep link with it.
router.post('/claims/share', verifyToken, requireRole('brand_ambassador'), ctrl.shareClaimsReport);
// PHASE 5 - BA dashboard/stats aggregates. Scoped server-side to
// req.user.id, never a client-supplied BA id.
router.get('/stats/mine', verifyToken, requireRole('brand_ambassador'), ctrl.getBaStats);
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

// PHASE 10 - payout rules & commission tiers (global + per-BA override).
// Nested under /brand-ambassadors since payout_rules/commission_tiers
// are always scoped to this feature, mirroring how claims/stats above
// are nested rather than living at the API root.
router.get('/payout-rules', verifyToken, requireRole('admin'), payoutRulesCtrl.getPayoutRules);
router.patch('/payout-rules/global', verifyToken, requireRole('admin'), payoutRulesCtrl.updateGlobalPayoutRule);
router.patch('/:baId/payout-rule-override', verifyToken, requireRole('admin'), payoutRulesCtrl.setBaPayoutOverride);
router.get('/commission-tiers', verifyToken, requireRole('admin'), payoutRulesCtrl.getCommissionTiers);
router.patch('/commission-tiers/global', verifyToken, requireRole('admin'), payoutRulesCtrl.updateCommissionTiers);
router.patch('/:baId/commission-tiers-override', verifyToken, requireRole('admin'), payoutRulesCtrl.setBaCommissionTierOverride);

// PHASE 19 - Qualification Job Dry-Run Mode. Admin-triggered manual
// run, alongside the Phase 10 Payout Rules screen - side-effect-free,
// safe to call as often as needed (e.g. right after a rate/tier
// change) without touching the live scheduled job.
router.post('/qualification/dry-run', verifyToken, requireRole('admin'), payoutRulesCtrl.runQualificationDryRun);
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
