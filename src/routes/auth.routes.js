const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');

router.post('/landlord/register', authController.registerLandlord);
router.post('/verify-otp', authController.verifyOTP);
router.post('/resend-otp', authController.resendOTP);
router.post('/login', authController.login);
router.post('/forgot-password/request', authController.requestPasswordReset);
router.post('/forgot-password/reset', authController.resetPassword);
router.post('/admin/login', authController.adminLogin);
router.post('/admin/verify-otp', authController.adminVerifyOTP);

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
router.patch('/landlord/payment-method', verifyToken, requireRole('landlord', 'manager'), requireNotCaretaker('Caretakers cannot edit payment method details. Contact the landlord or property manager.'), authController.updatePaymentMethod);

// Protected: either role - used both for the forced first-login
// change and for a voluntary change later from the account menu.
router.post('/change-password', verifyToken, requireRole('landlord', 'tenant', 'manager', 'scout'), authController.changePassword);

module.exports = router;
