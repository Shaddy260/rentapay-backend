const express = require('express');
const router = express.Router();
const maintenanceController = require('../controllers/maintenance.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);
router.post('/', requireRole('tenant'), maintenanceController.submitMaintenanceRequest);
router.get('/mine', requireRole('tenant'), maintenanceController.listMyMaintenanceRequests);
router.get('/', requireRole('landlord', 'manager'), maintenanceController.listMaintenanceRequests);
router.patch('/:requestId/status', requireRole('landlord', 'manager'), maintenanceController.updateMaintenanceStatus);

module.exports = router;
