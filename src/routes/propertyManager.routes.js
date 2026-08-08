const express = require('express');
const router = express.Router();
const managerController = require('../controllers/propertyManager.controller');
const { verifyToken, requireRole, requireLandlordOnly, requireNotCaretaker } = require('../middleware/auth.middleware');

router.use(verifyToken);

// Read access: landlord, full property managers (to see peers), and
// admin. Caretakers do NOT get this - their Settings screen only shows
// their own contact and the properties they're assigned to, never the
// landlord's list of other managers/caretakers.
router.get(
  '/',
  requireRole('landlord', 'manager', 'admin'),
  requireNotCaretaker('Caretakers cannot view the list of property managers.'),
  managerController.listManagers
);
router.get('/me', requireRole('manager'), managerController.getMyAccess);

// Adding/removing managers and changing who they're assigned to is
// locked to the landlord themself - this is the one settings action a
// property manager must never be able to do.
router.post('/', requireRole('landlord'), requireLandlordOnly('Only the landlord can add a property manager.'), managerController.addManager);
router.patch('/:managerId/assignments', requireRole('landlord'), requireLandlordOnly('Only the landlord can change a property manager\'s access.'), managerController.updateAssignments);
router.delete('/:managerId', requireRole('landlord'), requireLandlordOnly('Only the landlord can remove a property manager.'), managerController.removeManager);

// Editing a manager's own contact details - the manager themself, or
// their landlord, may do this (checked inside the controller).
router.patch('/:managerId', requireRole('landlord', 'manager'), managerController.updateManager);

module.exports = router;
