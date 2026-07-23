const express = require('express');
const router = express.Router();
const unitController = require('../controllers/unit.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');

router.use(verifyToken);

router.post('/', requireRole('landlord', 'manager'), requireNotCaretaker('Caretakers cannot add units. Contact the landlord or property manager.'), unitController.createUnit);
router.get('/', requireRole('landlord', 'manager', 'admin'), unitController.listUnits);
router.get('/landlord/:landlordId', requireRole('admin'), unitController.listUnits);
router.get('/pending-rent-changes', requireRole('landlord', 'manager', 'admin'), unitController.listPendingRentChanges);
router.get('/:unitId', requireRole('landlord', 'manager', 'admin'), unitController.getUnit);
router.patch('/:unitId/rent', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot change rent amounts. Contact the landlord or property manager.'), unitController.updateRent);
router.post('/bulk-rent', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot change rent amounts. Contact the landlord or property manager.'), unitController.bulkUpdateRent);
router.patch('/:unitId/name', requireRole('landlord', 'manager', 'admin'), unitController.renameUnit);
// Caretakers ARE allowed to change due dates (only rent amounts,
// deletions, and other destructive/financial actions are blocked for
// them) - see requireNotCaretaker's usage on the other routes below.
router.patch('/:unitId/due-date', requireRole('landlord', 'manager', 'admin'), unitController.updateDueDate);
router.patch(
  '/:unitId/payment-override',
  requireRole('landlord', 'manager', 'admin'),
  requireNotCaretaker('Caretakers cannot change the payment method. Contact the landlord or property manager.'),
  unitController.updatePaymentOverride
);
router.patch('/:unitId/status', requireRole('landlord', 'manager', 'admin'), unitController.updateUnitStatus);
// Caretakers ARE allowed to confirm a unit is still vacant (same
// "not destructive/financial" bucket as due-date above).
router.patch('/:unitId/verify', requireRole('landlord', 'manager', 'admin'), unitController.verifyUnit);
router.delete('/:unitId', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot remove units. Contact the landlord or property manager.'), unitController.removeUnit);
router.post('/:unitId/extra-charges', requireRole('landlord', 'manager', 'admin'), requireNotCaretaker('Caretakers cannot add extra charges. Contact the landlord or property manager.'), unitController.addExtraCharge);

module.exports = router;
