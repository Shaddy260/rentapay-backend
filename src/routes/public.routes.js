const express = require('express');
const router = express.Router();
const publicController = require('../controllers/public.controller');
const tenantOnboardingController = require('../controllers/tenantOnboarding.controller');
const landlordLeadController = require('../controllers/landlordLead.controller');

// Deliberately NOT behind verifyToken - this is the free, public,
// no-login vacant-unit listings surface (direct request: "fully
// open, no login needed to search").
router.get('/listings', publicController.listVacantUnits);
router.get('/listings/counties', publicController.listSearchableAreas);
router.get('/listings/:unitId/contact', publicController.getUnitContact);

// FIX (spec item 2.1): backs the QR code printed on every payment
// receipt (see pdfReport.service.js) - no auth, since the whole point
// is that scanning a printed receipt works without logging in.
router.get('/receipts/:paymentId/verify', publicController.verifyReceipt);

// FEATURE (direct request #4): resolves a tenant's opt-in shareable
// reputation link. No auth - see public.controller.js's
// getSharedReputation for why.
router.get('/reputation/:token', publicController.getSharedReputation);

// FIX (spec item 9.2): resolves an email typed into the vacant-listing
// contact form to a reputation share link, so the tenant no longer has
// to manually paste one. See public.controller.js for why this never
// returns the raw email.
router.get('/reputation-by-email', publicController.getReputationShareLinkByEmail);

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

// PHASE 9 - public marketing landlord-lead capture form. No auth -
// this is the whole point (shared out by marketing, filled in by the
// landlord themself, no account needed to submit it).
router.post('/landlord-leads', landlordLeadController.submitLandlordLead);

module.exports = router;
