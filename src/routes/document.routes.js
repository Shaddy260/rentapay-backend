// src/routes/document.routes.js
const express = require('express');
const router = express.Router();
const documentController = require('../controllers/document.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');
const { handleDocumentUpload } = require('../middleware/upload.middleware');

router.use(verifyToken);

// Landlord/manager: upload (for any of their tenants) + delete
// (caretakers excluded - leases are sensitive, same tier of action as
// removing units/tenants elsewhere).
// Tenant: upload their own documents too (e.g. ID copy, signed lease
// scan) - tenantId is forced server-side to their own id in the
// controller, never trusted from the request. Delete stays
// landlord/manager only; a tenant can add to their file but not
// remove from it.
router.post(
  '/',
  requireRole('landlord', 'manager', 'tenant'),
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
