const express = require('express');
const router = express.Router();
const scoutController = require('../controllers/scout.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

// PUBLIC - shown on the /scout landing page before sign-up, and again
// during county selection right after OTP verify.
router.get('/counties', scoutController.getCountyPricing);
router.post('/register', scoutController.registerScout);
// OTP verify + login + resend-otp are NOT duplicated here - Phase 2/3
// widened auth.controller.js's verifyOTP/resendOTP/login to already
// accept accountType/role 'scout' generically, so the existing
// /api/auth/verify-otp, /api/auth/resend-otp, and /api/auth/login
// routes handle a Scout exactly like any other account type.

// PROTECTED - requires a verified, logged-in Scout.
router.post('/subscribe', verifyToken, requireRole('scout'), scoutController.subscribeCounties);
router.post('/subscribe/manual', verifyToken, requireRole('scout'), scoutController.submitManualCountyPayment);
router.get('/subscribe/manual/latest', verifyToken, requireRole('scout'), scoutController.getMyLatestManualCountyPayment);
router.get('/my-profile', verifyToken, requireRole('scout'), scoutController.getMyProfile);
router.get('/my-subscriptions', verifyToken, requireRole('scout'), scoutController.getMySubscriptions);
router.get('/vacancies', verifyToken, requireRole('scout'), scoutController.getVacancies);
router.post('/refer', verifyToken, requireRole('scout'), scoutController.referUnit);
router.get('/my-referrals', verifyToken, requireRole('scout'), scoutController.getMyReferrals);

// LANDLORD/MANAGER - the one-tap "mark this referral viewed" hook (see
// markReferralViewed's own comment for why this isn't scoped tighter
// than requireRole here - ownership is still checked inside).
router.patch('/referrals/:referralId/mark-viewed', verifyToken, requireRole('landlord', 'manager'), scoutController.markReferralViewed);

// LANDLORD - block/unblock a scout from seeing their units + messaging
// them, and the platform-wide opt-out toggle (Pass 1 fix: getVacancies
// previously ignored both entirely).
router.get('/blocked', verifyToken, requireRole('landlord'), scoutController.listBlockedScouts);
router.post('/block', verifyToken, requireRole('landlord'), scoutController.blockScout);
router.post('/unblock', verifyToken, requireRole('landlord'), scoutController.unblockScout);
router.get('/visibility', verifyToken, requireRole('landlord'), scoutController.getScoutVisibilitySettings);
router.put('/visibility', verifyToken, requireRole('landlord'), scoutController.setScoutVisibility);

// ADMIN - review manual Paybill submissions (mirrors
// landlordManualSubscriptionPayment.routes.js exactly).
router.get('/admin/manual-payments', verifyToken, requireRole('admin'), scoutController.listManualCountyPayments);
router.post('/admin/manual-payments/:id/confirm', verifyToken, requireRole('admin'), scoutController.confirmManualCountyPayment);
router.post('/admin/manual-payments/:id/reject', verifyToken, requireRole('admin'), scoutController.rejectManualCountyPayment);
router.delete('/admin/manual-payments/:id', verifyToken, requireRole('admin'), scoutController.deleteManualCountyPayment);

module.exports = router;
