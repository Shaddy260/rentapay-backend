const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');

router.post('/landlord/register', authController.registerLandlord);
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
router.post('/login', authController.login);
router.post('/google', authController.loginWithGoogle);
router.post('/forgot-password/request', authController.requestPasswordReset);
router.post('/forgot-password/reset', authController.resetPassword);
// SECTION 3 (General Manager dedicated login) - deliberately its own
// endpoint, mirroring the dedicated frontend route at /manager-account
// (see App.jsx), not the shared /login used by landlords/managers/
// tenants and not the hidden /admin/login screen either.
router.post('/manager-account/login', authController.generalManagerLogin);
router.post('/manager-account/forgot-password', authController.generalManagerForgotPassword);
router.post('/manager-account/reset-password', authController.generalManagerResetPassword);
router.post('/admin/login', authController.adminLogin);
router.post('/admin/verify-otp', authController.adminVerifyOTP);
router.post('/admin/forgot-password', authController.adminForgotPassword);
router.post('/admin/reset-password', authController.adminResetPassword);
router.post('/admin/change-password', verifyToken, requireRole('admin'), authController.changeAdminPassword);

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
router.post('/change-password', verifyToken, requireRole('landlord', 'tenant', 'manager', 'brand_ambassador', 'general_manager'), authController.changePassword);
router.post('/dismiss-onboarding', verifyToken, requireRole('landlord', 'tenant', 'manager'), authController.dismissOnboarding);

module.exports = router;
