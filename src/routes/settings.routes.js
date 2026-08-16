// src/routes/settings.routes.js
const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/settings.controller');
const pricingCtrl = require('../controllers/subscriptionPricing.controller');

// Public router - mount at /api/settings (no auth). Read by every
// portal's Help modal, including the logged-out login screen.
const publicRouter = express.Router();
publicRouter.get('/public/help-contacts', ctrl.getPublicHelpContacts);

// Live base rate + period discount tiers - no auth, since this is
// needed on the pre-login signup screen (RegisterFlow.jsx) to price
// a brand-new landlord's first subscription correctly. Read-only,
// no loyalty/history data exposed.
publicRouter.get('/public/subscription-pricing', pricingCtrl.getPublicSubscriptionPricing);

// Admin router - mount at /api/admin/settings.
const adminRouter = express.Router();
adminRouter.get('/', verifyToken, requireRole('admin'), ctrl.getAdminSettings);
adminRouter.patch('/help-contacts', verifyToken, requireRole('admin'), ctrl.updateHelpContacts);

// Item 3: multiple call/WhatsApp numbers - list/add/edit/remove,
// rather than overwriting one fixed field.
adminRouter.get('/help-contacts/numbers', verifyToken, requireRole('admin'), ctrl.listHelpContactNumbers);
adminRouter.post('/help-contacts/numbers', verifyToken, requireRole('admin'), ctrl.createHelpContactNumber);
adminRouter.patch('/help-contacts/numbers/:id', verifyToken, requireRole('admin'), ctrl.updateHelpContactNumber);
adminRouter.delete('/help-contacts/numbers/:id', verifyToken, requireRole('admin'), ctrl.deleteHelpContactNumber);

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

// Loyalty discounts for landlords who've subscribed consecutively.
adminRouter.get('/loyalty-discounts/candidates', verifyToken, requireRole('admin'), pricingCtrl.getLoyaltyCandidates);
adminRouter.get('/loyalty-discounts/active', verifyToken, requireRole('admin'), pricingCtrl.getActiveLoyaltyDiscounts);
adminRouter.get('/loyalty-discounts/history', verifyToken, requireRole('admin'), pricingCtrl.getLoyaltyDiscountHistory);
adminRouter.post('/loyalty-discounts/bulk-grant', verifyToken, requireRole('admin'), pricingCtrl.bulkGrantLoyaltyDiscount);
adminRouter.delete('/loyalty-discounts/:landlordId', verifyToken, requireRole('admin'), pricingCtrl.revokeLoyaltyDiscount);

module.exports = { publicRouter, adminRouter };
