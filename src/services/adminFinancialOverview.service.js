// src/services/adminFinancialOverview.service.js
//
// Premium Redesign Plan - Phase 9: Admin Financial Overview & Expense
// Tracking.
//
// One month at a time: earned (subscription_payments actually
// collected from landlords that month) -> owed to BAs
// (ba_commission_earnings for that billing cycle) -> remaining
// (earned - owed) -> expenses (one-time entries for the month +
// every still-active recurring entry whose start month is on or
// before it) -> profit (remaining - expenses).

const supabase = require('../config/supabase');
const { captureException } = require('./sentry.service');
const logger = require('../utils/logger');

function monthKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(key) {
  // key = 'YYYY-MM'
  const [y, m] = key.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start, end };
}

/**
 * Every expense that applies to a given month: one-time entries whose
 * own month_key matches, plus every recurring entry that had already
 * started by that month and hasn't been stopped before it.
 */
async function expensesForMonth(monthKeyStr) {
  const { start } = monthBounds(monthKeyStr);
  const startDateStr = start.toISOString().slice(0, 10);

  const [{ data: oneTime, error: oneTimeErr }, { data: recurring, error: recurringErr }] = await Promise.all([
    supabase.from('admin_expenses').select('*').eq('recurrence', 'one_time').eq('month_key', startDateStr),
    supabase
      .from('admin_expenses')
      .select('*')
      .eq('recurrence', 'recurring')
      .lte('month_key', startDateStr)
      .or(`recurrence_ends_at.is.null,recurrence_ends_at.gt.${startDateStr}`),
  ]);
  if (oneTimeErr) throw oneTimeErr;
  if (recurringErr) throw recurringErr;

  return [...(oneTime || []), ...(recurring || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/**
 * Full monthly breakdown for the admin financial dashboard.
 * @param {string} [monthKeyStr] - 'YYYY-MM', defaults to the current month
 */
async function getMonthlyOverview(monthKeyStr) {
  const key = monthKeyStr || monthKey(new Date());
  const { start, end } = monthBounds(key);

  const [{ data: payments, error: paymentsErr }, { data: earnings, error: earningsErr }, expenses] = await Promise.all([
    supabase
      .from('subscription_payments')
      .select('amount')
      .eq('status', 'completed')
      .gte('paid_at', start.toISOString())
      .lt('paid_at', end.toISOString()),
    supabase.from('ba_commission_earnings').select('commission_amount').eq('billing_cycle', key),
    expensesForMonth(key),
  ]);
  if (paymentsErr) throw paymentsErr;
  if (earningsErr) throw earningsErr;

  const earned = (payments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const owedToBas = (earnings || []).reduce((sum, e) => sum + Number(e.commission_amount || 0), 0);
  const remaining = earned - owedToBas;
  const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const profit = remaining - totalExpenses;

  return {
    monthKey: key,
    earned: round2(earned),
    owedToBas: round2(owedToBas),
    remaining: round2(remaining),
    totalExpenses: round2(totalExpenses),
    profit: round2(profit),
    expenses: expenses.map((e) => ({
      id: e.id,
      label: e.label,
      amount: Number(e.amount),
      recurrence: e.recurrence,
      monthKey: e.month_key,
      recurrenceEndsAt: e.recurrence_ends_at,
    })),
  };
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

async function addExpense({ label, amount, recurrence, monthKeyStr, adminId }) {
  const cleanLabel = String(label || '').trim();
  if (!cleanLabel) throw Object.assign(new Error('An expense description is required.'), { status: 400 });
  const cleanAmount = Number(amount);
  if (Number.isNaN(cleanAmount) || cleanAmount <= 0) throw Object.assign(new Error('A valid expense amount is required.'), { status: 400 });
  const cleanRecurrence = recurrence === 'recurring' ? 'recurring' : 'one_time';
  const key = monthKeyStr || monthKey(new Date());
  const { start } = monthBounds(key);

  const { data, error } = await supabase
    .from('admin_expenses')
    .insert({
      label: cleanLabel,
      amount: cleanAmount,
      recurrence: cleanRecurrence,
      month_key: start.toISOString().slice(0, 10),
      created_by_admin_id: adminId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Stops a recurring expense from a given month onward (does not
 * delete it - months before this one still show it in their
 * breakdown). For a one-time expense, this is equivalent to deleting
 * it outright since it only ever applied to its own single month.
 */
async function stopExpense({ id, fromMonthKeyStr }) {
  const { data: existing, error: fetchErr } = await supabase.from('admin_expenses').select('*').eq('id', id).maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!existing) throw Object.assign(new Error('Expense not found.'), { status: 404 });

  if (existing.recurrence === 'one_time') {
    const { error } = await supabase.from('admin_expenses').delete().eq('id', id);
    if (error) throw error;
    return { deleted: true };
  }

  const key = fromMonthKeyStr || monthKey(new Date());
  const { start } = monthBounds(key);
  const { data, error } = await supabase
    .from('admin_expenses')
    .update({ recurrence_ends_at: start.toISOString().slice(0, 10), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return { stopped: true, expense: data };
}

async function deleteExpense(id) {
  const { error } = await supabase.from('admin_expenses').delete().eq('id', id);
  if (error) throw error;
  return { deleted: true };
}

module.exports = {
  monthKey,
  expensesForMonth,
  getMonthlyOverview,
  addExpense,
  stopExpense,
  deleteExpense,
};
