// src/controllers/adminFinancialOverview.controller.js
//
// Premium Redesign Plan - Phase 9: Admin Financial Overview & Expense
// Tracking.

const service = require('../services/adminFinancialOverview.service');
const logger = require('../utils/logger');
const { captureException } = require('../services/sentry.service');

// GET /api/admin/financial-overview?month=YYYY-MM
async function getOverview(req, res) {
  try {
    const overview = await service.getMonthlyOverview(req.query.month);
    res.json(overview);
  } catch (err) {
    logger.error('[adminFinancialOverview] getOverview failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to load the financial overview.' });
  }
}

// POST /api/admin/financial-overview/expenses
// body: { label, amount, recurrence: 'one_time'|'recurring', month: 'YYYY-MM' }
async function addExpense(req, res) {
  try {
    const { label, amount, recurrence, month } = req.body || {};
    const expense = await service.addExpense({ label, amount, recurrence, monthKeyStr: month, adminId: req.user?.id });
    res.json({ expense });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logger.error('[adminFinancialOverview] addExpense failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to add the expense.' });
  }
}

// POST /api/admin/financial-overview/expenses/:id/stop
// body: { fromMonth: 'YYYY-MM' } - only meaningful for recurring expenses
async function stopExpense(req, res) {
  try {
    const result = await service.stopExpense({ id: req.params.id, fromMonthKeyStr: req.body?.fromMonth });
    res.json(result);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    logger.error('[adminFinancialOverview] stopExpense failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to stop the expense.' });
  }
}

// DELETE /api/admin/financial-overview/expenses/:id
async function deleteExpense(req, res) {
  try {
    const result = await service.deleteExpense(req.params.id);
    res.json(result);
  } catch (err) {
    logger.error('[adminFinancialOverview] deleteExpense failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to delete the expense.' });
  }
}

module.exports = { getOverview, addExpense, stopExpense, deleteExpense };
