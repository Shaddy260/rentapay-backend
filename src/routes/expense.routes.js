// src/routes/expense.routes.js
const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expense.controller');
const { verifyToken, requireRole, requireNotCaretaker } = require('../middleware/auth.middleware');
const { handleExpenseReceiptUpload } = require('../middleware/upload.middleware');

router.use(verifyToken);
router.use(requireRole('landlord', 'manager'));

router.get('/', expenseController.listExpenses);
router.post(
  '/',
  requireNotCaretaker('Caretakers cannot log expenses. Contact the landlord or property manager.'),
  handleExpenseReceiptUpload,
  expenseController.createExpense
);
router.patch(
  '/:expenseId',
  requireNotCaretaker('Caretakers cannot edit expenses. Contact the landlord or property manager.'),
  expenseController.updateExpense
);
router.delete(
  '/:expenseId',
  requireNotCaretaker('Caretakers cannot delete expenses. Contact the landlord or property manager.'),
  expenseController.deleteExpense
);

module.exports = router;
