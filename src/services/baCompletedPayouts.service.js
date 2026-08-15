// src/services/baCompletedPayouts.service.js
//
// BUILD SPEC PHASE 10 - Fix: BA Payout Submission Overwrite Bug.
//
// Owns the admin "Completed" tab (browsable by month) AND the
// "Payment history" tab (the full, append-only, all-time log). Both
// read from `ba_payouts` where status = 'completed' - a table that is
// never written to by anything in the submission/edit-link flow, so
// nothing here can be dragged back to Pending by a BA resubmitting or
// editing their details.

const supabase = require('../config/supabase');

function truncateKes(amount) {
  return Math.floor(Number(amount || 0));
}

async function baInfoMap(baIds) {
  if (!baIds.length) return new Map();
  const { data, error } = await supabase.from('brand_ambassadors').select('id, full_name, ba_code').in('id', baIds);
  if (error) throw error;
  return new Map((data || []).map((b) => [b.id, b]));
}

async function submissionInfoMap(baIds) {
  if (!baIds.length) return new Map();
  const { data, error } = await supabase
    .from('ba_payment_submissions')
    .select('ba_id, mpesa_number, submitted_name, submitted_email')
    .in('ba_id', baIds);
  if (error) throw error;
  return new Map((data || []).map((s) => [s.ba_id, s]));
}

// ---------------------------------------------------------------------
// Every period_key that has at least one completed payout, with a
// quick count + total so admin can pick a month without opening each.
// ---------------------------------------------------------------------
async function listCompletedPeriods() {
  const { data: completed, error } = await supabase
    .from('ba_payouts')
    .select('period_key, amount')
    .eq('status', 'completed');
  if (error) throw error;
  if (!completed || completed.length === 0) return [];

  const totalsByPeriod = new Map();
  for (const p of completed) {
    if (!totalsByPeriod.has(p.period_key)) totalsByPeriod.set(p.period_key, { periodKey: p.period_key, count: 0, totalAmount: 0 });
    const t = totalsByPeriod.get(p.period_key);
    t.count += 1;
    t.totalAmount += truncateKes(p.amount);
  }

  return [...totalsByPeriod.values()].sort((a, b) => b.periodKey.localeCompare(a.periodKey));
}

// ---------------------------------------------------------------------
// Completed cards for one month (periodKey), or every month if
// omitted. Read-only.
// ---------------------------------------------------------------------
async function listCompleted({ periodKey } = {}) {
  let query = supabase
    .from('ba_payouts')
    .select('id, ba_id, period_key, amount, paid_at, paid_by_admin_id')
    .eq('status', 'completed')
    .order('paid_at', { ascending: false });
  if (periodKey) query = query.eq('period_key', periodKey);

  const { data: payouts, error } = await query;
  if (error) throw error;
  if (!payouts || payouts.length === 0) return { cards: [], totals: { count: 0, totalAmount: 0 } };

  const baIds = [...new Set(payouts.map((p) => p.ba_id))];
  const [baMap, subMap] = await Promise.all([baInfoMap(baIds), submissionInfoMap(baIds)]);

  const cards = payouts.map((p) => {
    const ba = baMap.get(p.ba_id);
    const submission = subMap.get(p.ba_id);
    return {
      payoutKey: `${p.ba_id}:${p.period_key}`,
      baId: p.ba_id,
      periodKey: p.period_key,
      baName: ba ? ba.full_name : 'Unknown BA',
      baCode: ba ? ba.ba_code : null,
      mpesaNumber: submission ? submission.mpesa_number : null,
      submittedName: submission ? submission.submitted_name : null,
      submittedEmail: submission ? submission.submitted_email : null,
      amountOwed: truncateKes(p.amount),
      paidAt: p.paid_at,
      paidByAdminId: p.paid_by_admin_id,
    };
  });

  const totals = cards.reduce((acc, c) => ({ count: acc.count + 1, totalAmount: acc.totalAmount + c.amountOwed }), { count: 0, totalAmount: 0 });

  return { cards, totals };
}

// ---------------------------------------------------------------------
// Payment history: the full, append-only, all-time audit trail of
// every payout ever marked paid, across every BA and every cycle -
// no status pill needed since everything here is by definition
// already settled. This is separate from "Completed" (which is meant
// for month-by-month browsing) so the running full log always exists
// regardless of which month is currently selected there.
// ---------------------------------------------------------------------
async function listPaymentHistory({ limit = 200 } = {}) {
  const { data: payouts, error } = await supabase
    .from('ba_payouts')
    .select('id, ba_id, period_key, amount, paid_at, paid_by_admin_id')
    .eq('status', 'completed')
    .order('paid_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  if (!payouts || payouts.length === 0) return { entries: [] };

  const baIds = [...new Set(payouts.map((p) => p.ba_id))];
  const baMap = await baInfoMap(baIds);

  const entries = payouts.map((p) => ({
    payoutKey: `${p.ba_id}:${p.period_key}`,
    baId: p.ba_id,
    baName: baMap.get(p.ba_id)?.full_name || 'Unknown BA',
    baCode: baMap.get(p.ba_id)?.ba_code || null,
    periodKey: p.period_key,
    amount: truncateKes(p.amount),
    paidAt: p.paid_at,
  }));

  return { entries };
}

module.exports = {
  truncateKes,
  listCompletedPeriods,
  listCompleted,
  listPaymentHistory,
};
