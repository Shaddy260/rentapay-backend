const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenant.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');

router.use(verifyToken);

// ---------------------------------------------------------------------
// Literal-path routes MUST be registered before any ':tenantId'
// wildcard route below - Express matches top-to-bottom, and
// '/:tenantId' will greedily capture any single path segment,
// including literal strings like 'balance' or 'profile'. This exact
// bug previously broke unit.controller.js's getUnit/listUnits (a
// '/:unitId' route registered before other literal routes caused
// false 404s) - fixed here proactively for tenants before it bites in
// the same way.
// ---------------------------------------------------------------------
router.post('/', requireRole('landlord', 'manager'), tenantController.addTenant);
router.get('/balance', requireRole('tenant'), tenantController.getBalance);
router.get('/payment-history', requireRole('tenant'), tenantController.getPaymentHistory);
router.get('/payment-history/pdf', requireRole('tenant'), tenantController.exportPaymentHistoryPdf);
router.get('/profile', requireRole('tenant'), tenantController.getProfile);
router.patch('/profile', requireRole('tenant'), tenantController.editOwnProfile);
router.post('/bulk-remind', requireRole('landlord', 'manager'), tenantController.sendBulkReminders);
// Section 5: WhatsApp reminder deep-link data (client-side wa.me links only - no WhatsApp Business API).
router.get('/bulk-remind/whatsapp', requireRole('landlord', 'manager'), tenantController.getWhatsAppBulkReminderQueue);
router.get('/export-list', requireRole('landlord', 'manager'), tenantController.listTenantsForExport);
router.get('/archived', requireRole('landlord', 'manager'), tenantController.listArchivedTenants);
router.post('/bulk-sms', requireRole('landlord', 'manager'), tenantController.sendBulkSmsToSelectedTenants);
router.post('/vacating-notice', requireRole('tenant'), tenantController.submitVacatingNotice);
router.delete('/vacating-notice', requireRole('tenant'), tenantController.cancelVacatingNotice);
router.get('/reputations', requireRole('landlord', 'manager'), tenantController.listTenantReputations);
router.post('/rate-landlord', requireRole('tenant'), tenantController.rateLandlord);
router.get('/landlord-reputation', requireRole('tenant'), tenantController.getMyLandlordReputation);
// direct request #8: landlords/managers/caretakers can now see their
// OWN aggregate rating (previously nowhere in the app), and tenants
// can rate their property's manager/caretaker separately from the
// landlord.
router.get('/my-reputation', requireRole('landlord'), tenantController.getMyReputationAsLandlord);
router.get('/rateable-staff', requireRole('tenant'), tenantController.listRateableStaff);
router.post('/rate-staff/:staffId', requireRole('tenant'), tenantController.rateStaff);
router.post('/my-ratings/:ratingId/flag', requireRole('tenant'), tenantController.flagTenantRating);
router.get('/my-staff-reputation', requireRole('manager'), tenantController.getMyStaffReputation);
// FEATURE (direct request): property reputation, rated by current
// tenants of that property - sits beside the landlord/staff rating
// routes above, but aggregates by property_id rather than a person.
router.post('/rate-property', requireRole('tenant'), tenantController.rateProperty);
router.get('/property-reputation', requireRole('tenant'), tenantController.getMyPropertyReputation);

// FEATURE (direct request #4): tenant-generated shareable link to their
// own portable reputation, to paste into a WhatsApp inquiry when
// contacting a landlord about a vacant unit. See public.routes.js for
// the no-auth endpoint that actually resolves the link.
router.get('/reputation-share-link', requireRole('tenant'), tenantController.getMyReputationShareLink);

// ---------------------------------------------------------------------
// ':tenantId' wildcard routes - anything below this point
// ---------------------------------------------------------------------
// DIRECT REQUEST: rating-reminder popups. Must stay ABOVE the
// generic '/:tenantId' route below, or Express would treat
// "rating-reminders" as a tenantId and 404/misroute.
router.get('/rating-reminders/next', requireRole('landlord', 'manager'), tenantController.getNextRatingReminder);
router.post('/rating-reminders/:reminderId/snooze', requireRole('landlord', 'manager'), tenantController.snoozeRatingReminder);

router.get('/:tenantId', requireRole('landlord', 'manager', 'admin'), tenantController.getTenant);
router.delete('/:tenantId', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot remove tenants. Contact the landlord or property manager.'), tenantController.deleteTenant);
router.patch('/:tenantId', requireRole('landlord', 'manager', 'admin'), tenantController.editTenantDetails);
router.get('/:tenantId/balance', requireRole('landlord', 'manager', 'admin'), tenantController.getBalance);
router.patch('/:tenantId/balance', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot edit a tenant\'s balance. Contact the landlord or property manager.'), tenantController.editBalance);
router.patch('/:tenantId/deposit', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot settle a tenant\'s deposit. Contact the landlord or property manager.'), tenantController.settleDeposit);
router.post('/:tenantId/remind', requireRole('landlord', 'manager', 'admin'), tenantController.remindTenant);
router.get('/:tenantId/remind/whatsapp', requireRole('landlord', 'manager', 'admin'), tenantController.getWhatsAppReminderInfo);
router.post('/:tenantId/transfer', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot transfer tenants between units. Contact the landlord or property manager.'), tenantController.transferTenant);
router.post('/:tenantId/restore', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot restore archived tenants. Contact the landlord or property manager.'), tenantController.restoreTenant);
router.post('/:tenantId/vacating-notice/revoke', requireRole('landlord', 'manager', 'admin'), tenantController.revokeVacatingNotice);
router.post('/:tenantId/rate', requireRole('landlord', 'manager'), tenantController.rateTenant);
router.get('/:tenantId/reputation', requireRole('landlord', 'manager', 'tenant', 'admin'), tenantController.getTenantReputation);

module.exports = router;
