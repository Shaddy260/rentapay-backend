// src/routes/dataExport.routes.js
const express = require('express');
const router = express.Router();
const dataExportController = require('../controllers/dataExport.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);
router.get('/me', requireRole('landlord', 'manager'), dataExportController.exportMyData);

module.exports = router;
