// src/routes/settings.routes.js
const express = require('express');
const { verifyToken, requireRole, requireGmPermission, requireOperationsPinConfirmation } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/settings.controller');
const pricingCtrl = require('../controllers/subscriptionPricing.controller');
const platformPaymentCtrl = require('../controllers/platformPaymentSettings.controller');

// Public router - mount at /api/settings (no auth). Read by every
// portal's Help modal, including the logged-out login screen.
const publicRouter = express.Router();
publicRouter.get('/public/help-contacts', ctrl.getPublicHelpContacts);

// Live base rate + period discount tiers - no auth, since this is
// needed on the pre-login signup screen (RegisterFlow.jsx) to price
// a brand-new landlord's first subscription correctly. Read-only,
// no loyalty/history data exposed.
publicRouter.get('/public/subscription-pricing', pricingCtrl.getPublicSubscriptionPricing);

// Live Paybill/Till a landlord/manager/caretaker should send their
// manual subscription payment to (see PaymentDetailsCard.jsx). Any
// logged-in payer can read this - it's not admin-only to VIEW, only
// to change (see adminRouter below).
publicRouter.get('/platform-payment', verifyToken, platformPaymentCtrl.getPayerFacingPaymentSettings);

// Admin router - mount at /api/admin/settings.
const adminRouter = express.Router();
adminRouter.get('/', verifyToken, requireRole('admin', 'general_manager'), ctrl.getAdminSettings);
// FIX (direct request): a General Manager can always SEE the Help &
// Contact Details screen (support email, call numbers, WhatsApp
// numbers) - same visibility-vs-mandate split used for manual
// payments/help requests above. Editing still needs admin to have
// explicitly granted can_manage_help_contacts to that specific GM.
adminRouter.patch('/help-contacts', verifyToken, requireRole('admin', 'general_manager'), requireGmPermission('can_manage_help_contacts'), ctrl.updateHelpContacts);

// Item 3: multiple call/WhatsApp numbers - list/add/edit/remove,
// rather than overwriting one fixed field.
adminRouter.get('/help-contacts/numbers', verifyToken, requireRole('admin', 'general_manager'), ctrl.listHelpContactNumbers);
adminRouter.post('/help-contacts/numbers', verifyToken, requireRole('admin', 'general_manager'), requireGmPermission('can_manage_help_contacts'), ctrl.createHelpContactNumber);
adminRouter.patch('/help-contacts/numbers/:id', verifyToken, requireRole('admin', 'general_manager'), requireGmPermission('can_manage_help_contacts'), ctrl.updateHelpContactNumber);
adminRouter.delete('/help-contacts/numbers/:id', verifyToken, requireRole('admin', 'general_manager'), requireGmPermission('can_manage_help_contacts'), ctrl.deleteHelpContactNumber);

// Subscription fee (base rate + period discount tiers) - affects
// signup, adding a property, adding units, and renewals everywhere,
// since they all read from this via utils/pricing.js.
// SECTION 6 (General Manager spec): "Platform unit pricing (price per
// unit per month)" is one of the two fields explicitly locked to
// admin-only editing - "General Managers can see these current
// settings but have no ability to change them." The GET below opens
// to 'general_manager' so a GM can view the live rate; the PATCH
// stays requireRole('admin') only, genuinely non-editable for that
// role at the API level.
adminRouter.get('/subscription-pricing', verifyToken, requireRole('admin', 'general_manager'), pricingCtrl.getSubscriptionPricing);
adminRouter.patch('/subscription-pricing', verifyToken, requireRole('admin'), pricingCtrl.updateSubscriptionPricing);

// Platform's OWN receiving Paybill/Till for landlord subscription
// payments (the "pay manually" fallback destination) - direct
// request: "strictly admin only". Unlike subscription-pricing above,
// a General Manager gets no access here at all, view or edit - this
// controls where landlords' money is actually sent, so it stays
// admin-only at the API level, not just hidden in the UI.
adminRouter.get('/platform-payment', verifyToken, requireRole('admin'), platformPaymentCtrl.getPlatformPaymentSettings);
adminRouter.patch('/platform-payment', verifyToken, requireRole('admin'), platformPaymentCtrl.updatePlatformPaymentSettings);

// Loyalty discounts for landlords who've subscribed consecutively.
// FEATURE (direct request): a General Manager can always VIEW these
// three (candidates/active/history) - the toggle from
// GeneralManagersPanel.jsx only gates the two write actions below.
adminRouter.get('/loyalty-discounts/candidates', verifyToken, requireRole('admin', 'general_manager'), pricingCtrl.getLoyaltyCandidates);
adminRouter.get('/loyalty-discounts/active', verifyToken, requireRole('admin', 'general_manager'), pricingCtrl.getActiveLoyaltyDiscounts);
adminRouter.get('/loyalty-discounts/history', verifyToken, requireRole('admin', 'general_manager'), pricingCtrl.getLoyaltyDiscountHistory);
adminRouter.post('/loyalty-discounts/bulk-grant', verifyToken, requireRole('admin', 'general_manager'), requireGmPermission('can_grant_loyalty_discounts'), requireOperationsPinConfirmation, pricingCtrl.bulkGrantLoyaltyDiscount);
adminRouter.delete('/loyalty-discounts/:landlordId', verifyToken, requireRole('admin', 'general_manager'), requireGmPermission('can_grant_loyalty_discounts'), requireOperationsPinConfirmation, pricingCtrl.revokeLoyaltyDiscount);

module.exports = { publicRouter, adminRouter };
