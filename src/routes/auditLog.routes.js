// src/routes/auditLog.routes.js
const express = require('express');
const router = express.Router();
const auditLogController = require('../controllers/auditLog.controller');
const { verifyToken, requireRole } = require('../middleware/auth.middleware');

router.use(verifyToken);
router.use(requireRole('landlord', 'manager'));

router.get('/expenses-documents', auditLogController.getExpenseDocumentActivity);

module.exports = router;
