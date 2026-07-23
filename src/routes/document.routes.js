// src/routes/document.routes.js
const express = require('express');
const router = express.Router();
const documentController = require('../controllers/document.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');
const { handleDocumentUpload } = require('../middleware/upload.middleware');

router.use(verifyToken);

// Landlord/manager: upload + delete (caretakers excluded - leases are
// sensitive, same tier of action as removing units/tenants elsewhere).
// Tenant: view/list their own only (see listDocuments, which branches
// on req.user.role).
router.post(
  '/',
  requireRole('landlord', 'manager'),
  requireNotCaretaker('Caretakers cannot upload documents. Contact the landlord or property manager.'),
  handleDocumentUpload,
  documentController.uploadDocument
);
router.get('/', requireRole('landlord', 'manager', 'tenant'), documentController.listDocuments);
router.delete(
  '/:documentId',
  requireRole('landlord', 'manager'),
  requireNotCaretaker('Caretakers cannot delete documents. Contact the landlord or property manager.'),
  documentController.deleteDocument
);

module.exports = router;
