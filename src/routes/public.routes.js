const express = require('express');
const router = express.Router();
const publicController = require('../controllers/public.controller');
const tenantOnboardingController = require('../controllers/tenantOnboarding.controller');

// Deliberately NOT behind verifyToken - this is the free, public,
// no-login vacant-unit listings surface (direct request: "fully
// open, no login needed to search").
router.get('/listings', publicController.listVacantUnits);
router.get('/listings/counties', publicController.listSearchableAreas);
router.get('/listings/:unitId/contact', publicController.getUnitContact);

// FEATURE (direct request #4): resolves a tenant's opt-in shareable
// reputation link. No auth - see public.controller.js's
// getSharedReputation for why.
router.get('/reputation/:token', publicController.getSharedReputation);

// DIRECT REQUEST: browser popups for vacancy alerts to ANY visitor,
// logged in or not. See vacancyAlertPush.service.js + the
// vacancy_alert_subscriptions table. No auth on any of these.
router.get('/vacancy-alerts/toast', publicController.getToastVacancy);
router.get('/vacancy-alerts/vapid-public-key', publicController.getVacancyAlertVapidPublicKey);
router.post('/vacancy-alerts/subscribe', publicController.subscribeVacancyAlerts);
router.post('/vacancy-alerts/unsubscribe', publicController.unsubscribeVacancyAlerts);

// FEATURE: Tenant Self-Onboarding via Shared Link. No auth - a tenant
// opens this straight from a WhatsApp link with no account at all.
router.get('/onboarding/:token', tenantOnboardingController.getOnboardingForm);
router.post('/onboarding/:token/check-duplicate', tenantOnboardingController.checkOnboardingDuplicate);
router.post('/onboarding/:token/email/send-otp', tenantOnboardingController.sendOnboardingEmailOtp);
router.post('/onboarding/:token/email/verify-otp', tenantOnboardingController.verifyOnboardingEmailOtp);
router.post('/onboarding/:token/submit', tenantOnboardingController.submitOnboardingRequest);

module.exports = router;
