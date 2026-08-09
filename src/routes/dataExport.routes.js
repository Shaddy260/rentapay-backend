// src/routes/dataExport.routes.js
const express = require('express');
const router = express.Router();
const dataExportController = require('../controllers/dataExport.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);
// FIX (spec item 3): tenants get the same self-service export, scoped
// to their own data - see exportMyData's branch to exportTenantData.
router.get('/me', requireRole('landlord', 'manager', 'tenant'), dataExportController.exportMyData);

module.exports = router;
