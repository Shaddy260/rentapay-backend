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
router.get('/profile', requireRole('tenant'), tenantController.getProfile);
router.post('/bulk-remind', requireRole('landlord', 'manager'), tenantController.sendBulkReminders);
router.get('/export-list', requireRole('landlord', 'manager'), tenantController.listTenantsForExport);
router.get('/archived', requireRole('landlord', 'manager'), tenantController.listArchivedTenants);
router.post('/bulk-sms', requireRole('landlord', 'manager'), tenantController.sendBulkSmsToSelectedTenants);
router.post('/vacating-notice', requireRole('tenant'), tenantController.submitVacatingNotice);
router.delete('/vacating-notice', requireRole('tenant'), tenantController.cancelVacatingNotice);

// ---------------------------------------------------------------------
// ':tenantId' wildcard routes - anything below this point
// ---------------------------------------------------------------------
router.get('/:tenantId', requireRole('landlord', 'manager', 'admin'), tenantController.getTenant);
router.delete('/:tenantId', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot remove tenants. Contact the landlord or property manager.'), tenantController.deleteTenant);
router.patch('/:tenantId', requireRole('landlord', 'manager', 'admin'), tenantController.editTenantDetails);
router.get('/:tenantId/balance', requireRole('landlord', 'manager', 'admin'), tenantController.getBalance);
router.patch('/:tenantId/balance', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot edit a tenant\'s balance. Contact the landlord or property manager.'), tenantController.editBalance);
router.patch('/:tenantId/deposit', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot settle a tenant\'s deposit. Contact the landlord or property manager.'), tenantController.settleDeposit);
router.post('/:tenantId/remind', requireRole('landlord', 'manager', 'admin'), tenantController.remindTenant);
router.post('/:tenantId/transfer', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot transfer tenants between units. Contact the landlord or property manager.'), tenantController.transferTenant);
router.post('/:tenantId/restore', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot restore archived tenants. Contact the landlord or property manager.'), tenantController.restoreTenant);
router.post('/:tenantId/vacating-notice/revoke', requireRole('landlord', 'manager', 'admin'), tenantController.revokeVacatingNotice);

module.exports = router;
