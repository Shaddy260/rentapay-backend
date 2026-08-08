const express = require('express');
const router = express.Router();
const propertyController = require('../controllers/property.controller');
const { verifyToken, requireRole, requirePropertyAccess } = require('../middleware/auth.middleware');

router.use(verifyToken);

router.get('/', requireRole('landlord', 'manager', 'admin'), propertyController.listProperties);
// Buying additional property "slots" is a billing action - landlord only.
router.post('/', requireRole('landlord'), propertyController.createProperty);
// Editing a property's own details (name, caretaker, contact) - a manager
// assigned to that property may do this too (checked in the controller).
router.patch(
  '/:propertyId',
  requireRole('landlord', 'manager'),
  requirePropertyAccess((req) => req.params.propertyId),
  propertyController.updateProperty
);
router.patch(
  '/units/:unitId/assign',
  requireRole('landlord', 'manager'),
  requirePropertyAccess((req) => req.body.propertyId),
  propertyController.assignUnitToProperty
);
// FOLLOW-UP: landlords/managers previously had no way to see a
// property's own reputation (tenants and the public listing page
// could, but the landlord dashboard couldn't).
router.get(
  '/:propertyId/reputation',
  requireRole('landlord', 'manager'),
  requirePropertyAccess((req) => req.params.propertyId),
  propertyController.getPropertyReputationForLandlord
);
router.post('/purchase', requireRole('landlord'), propertyController.initiatePropertyPurchase);
router.post('/:propertyId/renew', requireRole('landlord'), propertyController.renewPropertySubscription);
router.get('/purchase-status/:checkoutRequestId', requireRole('landlord'), propertyController.checkPropertyPaymentStatus);

module.exports = router;
