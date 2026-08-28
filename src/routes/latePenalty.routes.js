// src/routes/latePenalty.routes.js
//
// Mounted at /api/late-penalty in server.js. Landlord + manager can
// view/edit (same tier already used for rent amounts/due dates);
// caretakers are view-only, mirroring their existing access to
// payment-method settings.

const express = require('express');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/latePenalty.controller');

const router = express.Router();

// One settings row PER PROPERTY/APARTMENT - Settings -> Finances,
// apartment picker. Toggling this on and entering a percentage for a
// property applies it to every unit/tenant inside that property.
router.get('/properties/:propertyId/settings', verifyToken, requireRole('landlord', 'manager'), ctrl.getSettings);
router.patch(
  '/properties/:propertyId/settings',
  verifyToken,
  requireRole('landlord', 'manager'),
  requireNotCaretaker('Caretakers cannot edit the late payment penalty settings. Contact the landlord or property manager.'),
  ctrl.updateSettings
);

// Live plain-language preview while the form is being edited - no
// auth-scoped data touched, just runs the shared calculator.
router.post('/settings/preview', verifyToken, requireRole('landlord', 'manager'), ctrl.previewSettings);

// Per-tenant/per-period overrides (waive / custom amount / custom rate).
router.get('/tenants/:tenantId/overrides', verifyToken, requireRole('landlord', 'manager'), ctrl.listOverrides);
router.post(
  '/tenants/:tenantId/overrides',
  verifyToken,
  requireRole('landlord', 'manager'),
  requireNotCaretaker('Caretakers cannot waive or adjust late payment penalties. Contact the landlord or property manager.'),
  ctrl.createOverride
);
router.delete(
  '/overrides/:overrideId',
  verifyToken,
  requireRole('landlord', 'manager'),
  requireNotCaretaker('Caretakers cannot remove late payment penalty overrides. Contact the landlord or property manager.'),
  ctrl.removeOverride
);

module.exports = router;
