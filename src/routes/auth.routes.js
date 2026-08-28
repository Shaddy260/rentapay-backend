const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');
// Phase 2: shared Zod validation on write payloads (see
// middleware/validate.middleware.js + validation/schemas.js).
const { validate } = require('../middleware/validate.middleware');
const { landlordRegisterSchema, loginSchema, forgotPasswordRequestSchema, resetPasswordSchema, changePasswordSchema } = require('../validation/schemas');
const twoFactorController = require('../controllers/twoFactor.controller');

router.post('/landlord/register', validate(landlordRegisterSchema), authController.registerLandlord);
router.post('/verify-otp', authController.verifyOTP);
router.post('/resend-otp', authController.resendOTP);
// DIRECT REQUEST (same-page verification): verify email BEFORE the
// account is created, on the same "Your details" page as everything
// else - see requestLandlordEmailVerification / confirmLandlordEmailVerification.
router.post('/landlord/send-registration-email-otp', authController.requestLandlordEmailVerification);
router.post('/landlord/verify-registration-email-otp', authController.confirmLandlordEmailVerification);
// Legacy post-registration endpoints - kept only for any landlord
// account that predates this change and might still have
// email_verified = false; no longer called by the current signup flow.
router.post('/verify-landlord-email', authController.verifyLandlordEmailOTP);
router.post('/resend-landlord-email-otp', authController.resendLandlordEmailOTP);
router.post('/update-landlord-registration-email', authController.updateLandlordRegistrationEmail);
router.post('/landlord/initiate-payment', authController.initiateLandlordSubscriptionPayment);
router.post('/login', validate(loginSchema), authController.login);
// Second step of the OPTIONAL per-account 2FA toggle (landlord/tenant/
// manager/brand_ambassador) - only reached when login() above sees
// totp_enabled on the account and stops short of issuing a token.
router.post('/verify-login-totp', authController.verifyLoginTotp);
router.post('/google', authController.loginWithGoogle);
router.post('/forgot-password/request', validate(forgotPasswordRequestSchema), authController.requestPasswordReset);
router.post('/forgot-password/reset', validate(resetPasswordSchema), authController.resetPassword);
// SECTION 3 (General Manager dedicated login) - deliberately its own
// endpoint, mirroring the dedicated frontend route at /manager-account
// (see App.jsx), not the shared /login used by landlords/managers/
// tenants and not the hidden /admin/login screen either.
router.post('/manager-account/login', authController.generalManagerLogin);
// Mandatory 2FA (TOTP) for general managers - see generalManagerLogin's
// header comment. Same endpoint handles first-time setup confirmation
// and every regular login's second step.
router.post('/manager-account/verify-totp', authController.generalManagerVerifyTotp);
router.post('/manager-account/forgot-password', authController.generalManagerForgotPassword);
router.post('/manager-account/reset-password', authController.generalManagerResetPassword);
router.post('/admin/login', authController.adminLogin);
router.post('/admin/verify-otp', authController.adminVerifyOTP);
// Mandatory 2FA (TOTP) for admin - see adminLogin's header comment for
// why this replaced the emailed-code flow (fixes the "works once,
// then always wrong" bug and avoids per-login email cost).
router.post('/admin/confirm-totp-setup', authController.confirmAdminTotpSetup);
router.post('/admin/forgot-password', authController.adminForgotPassword);
router.post('/admin/reset-password', authController.adminResetPassword);
router.post('/admin/change-password', verifyToken, requireRole('admin'), authController.changeAdminPassword);

// OPTIONAL self-service 2FA toggle for landlord/tenant/manager/
// brand_ambassador accounts (admin and general_manager are mandatory
// and managed by the dedicated flows above, not here).
router.get('/2fa/status', verifyToken, requireRole('landlord', 'tenant', 'manager', 'brand_ambassador'), twoFactorController.status);
router.post('/2fa/enable/start', verifyToken, requireRole('landlord', 'tenant', 'manager', 'brand_ambassador'), twoFactorController.startEnable);
router.post('/2fa/enable/confirm', verifyToken, requireRole('landlord', 'tenant', 'manager', 'brand_ambassador'), twoFactorController.confirmEnable);
router.post('/2fa/disable', verifyToken, requireRole('landlord', 'tenant', 'manager', 'brand_ambassador'), twoFactorController.disable);

// FIX ("fingerprint login flickers back to the login screen after a
// few seconds during an admin lockdown, instead of just saying so"):
// biometric login (biometricAuth.js) previously released a
// device-stored token and navigated straight to the dashboard without
// ever asking the backend anything first - unlike password login,
// which already checks lockdown/account-validity inside login()
// before a token is ever issued. That meant a locked-down platform,
// or a token belonging to a since-revoked/suspended account, only
// surfaced once the dashboard's OWN data calls started failing a
// moment later, which is what looked like a "flicker." verifyToken
// already runs both of those checks on every request - this route
// exists purely so the frontend can run them BEFORE navigating,
// getting the exact same lockdown/suspension message the password
// path shows, instead of a confusing bounce-back.
router.get('/session-check', verifyToken, (req, res) => res.json({ valid: true, role: req.user.role, roleLevel: req.user.roleLevel }));

// Protected: requires a valid landlord JWT (issued by /login above)
router.post('/landlord/complete-setup-wizard', verifyToken, requireRole('landlord'), authController.completeSetupWizard);
router.get('/landlord/me', verifyToken, requireRole('landlord'), authController.getMyLandlordProfile);
router.get('/payment-method', verifyToken, requireRole('landlord', 'manager'), authController.getPaymentMethodForViewer);
router.patch('/landlord/property', verifyToken, requireRole('landlord'), authController.updatePropertyDetails);
router.patch('/landlord/contact', verifyToken, requireRole('landlord'), authController.updateMyContact);
router.post('/landlord/dispute-ba-attribution', verifyToken, requireRole('landlord'), authController.disputeBaAttribution);
router.patch('/landlord/payment-method', verifyToken, requireRole('landlord', 'manager'), requireNotCaretaker('Caretakers cannot edit payment method details. Contact the landlord or property manager.'), authController.updatePaymentMethod);

// Protected: either role - used both for the forced first-login
// change and for a voluntary change later from the account menu.
router.post('/change-password', verifyToken, requireRole('landlord', 'tenant', 'manager', 'brand_ambassador', 'general_manager'), validate(changePasswordSchema), authController.changePassword);
router.post('/dismiss-onboarding', verifyToken, requireRole('landlord', 'tenant', 'manager'), authController.dismissOnboarding);

module.exports = router;
