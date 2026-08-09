const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/tenantOnboarding.controller');
const { verifyToken, requireRole, requirePropertyAccess } = require('../middleware/auth.middleware');

router.use(verifyToken);

// Caretakers ARE allowed to generate/share the link, edit, and confirm
// requests (this is exactly the kind of on-the-ground, non-destructive,
// non-financial task caretakers are meant to help with elsewhere in
// the app - see requireNotCaretaker's usage on unit.routes.js for the
// contrast), so this whole feature is intentionally NOT gated by
// requireNotCaretaker.
router.get(
  '/link/:propertyId',
  requireRole('landlord', 'manager'),
  requirePropertyAccess((req) => req.params.propertyId),
  ctrl.getOrCreateLink
);
router.get('/requests', requireRole('landlord', 'manager'), ctrl.listOnboardingRequests);
router.patch('/requests/:id', requireRole('landlord', 'manager'), ctrl.editOnboardingRequest);
router.delete('/requests/:id', requireRole('landlord', 'manager'), ctrl.deleteOnboardingRequest);
router.post('/requests/:id/confirm', requireRole('landlord', 'manager'), ctrl.confirmOnboardingRequest);

module.exports = router;
