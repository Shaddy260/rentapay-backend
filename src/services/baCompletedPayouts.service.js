// src/services/baCompletedPayouts.service.js
//
// BA Monthly Payment Details & Payout Workflow - Phase 4.
//
// Owns the admin "Completed" tab: read-only list of paid
// ba_payment_submissions rows, browsable/filterable by the month each
// card originally belonged to (its own period_key - never the month
// it happened to get paid in), plus summary totals and the data feed
// for the payout PDF export.
//
// Mirrors baPendingPayouts.service.js's owed-amount computation
// (ba_commission_earnings, truncated to whole KES) so a card's amount
// here is identical to what it showed while still in Pending - paying
// it doesn't recompute or change the figure.

const supabase = require('../config/supabase');

function truncateKes(amount) {
  return Math.floor(Number(amount || 0));
}

// ---------------------------------------------------------------------
// Every period_key that has at least one 'paid' submission, with a
// quick count + total so the admin can pick a month without opening
// each one. Ordered most-recent month first.
// ---------------------------------------------------------------------
async function listCompletedPeriods() {
  const { data: paid, error: paidErr } = await supabase
    .from('ba_payment_submissions')
    .select('id, cycle_id, ba_id')
    .eq('status', 'paid');
  if (paidErr) throw paidErr;
  if (!paid || paid.length === 0) return [];

  const cycleIds = [...new Set(paid.map((p) => p.cycle_id))];
  const { data: cycles, error: cyclesErr } = await supabase
    .from('ba_payout_link_cycles')
    .select('id, period_key')
    .in('id', cycleIds);
  if (cyclesErr) throw cyclesErr;
  const periodByCycle = new Map((cycles || []).map((c) => [c.id, c.period_key]));

  const pairs = paid.map((p) => ({ baId: p.ba_id, periodKey: periodByCycle.get(p.cycle_id) })).filter((p) => p.periodKey);
  const owedMap = await computeOwedForPairs(pairs);

  const totalsByPeriod = new Map();
  for (const p of paid) {
    const periodKey = periodByCycle.get(p.cycle_id);
    if (!periodKey) continue;
    const owed = owedMap.get(`${p.ba_id}:${periodKey}`);
    const amount = owed ? owed.owedAmount : 0;
    if (!totalsByPeriod.has(periodKey)) totalsByPeriod.set(periodKey, { periodKey, count: 0, totalAmount: 0 });
    const t = totalsByPeriod.get(periodKey);
    t.count += 1;
    t.totalAmount += amount;
  }

  return [...totalsByPeriod.values()].sort((a, b) => b.periodKey.localeCompare(a.periodKey));
}

// ---------------------------------------------------------------------
// Shared with the Pending service's shape - duplicated locally (small,
// and keeps Phase 3/4 modules independent) rather than importing
// across phases.
// ---------------------------------------------------------------------
async function computeOwedForPairs(pairs) {
  if (!pairs.length) return new Map();

  const baIds = [...new Set(pairs.map((p) => p.baId))];
  const periodKeys = [...new Set(pairs.map((p) => p.periodKey))];

  const [{ data: earnings, error: earningsErr }, { data: landlordRoster, error: rosterErr }, { data: propertyRoster, error: propRosterErr }] =
    await Promise.all([
      supabase
        .from('ba_commission_earnings')
        .select('ba_id, commission_amount, percentage_applied, billing_cycle')
        .in('ba_id', baIds)
        .in('billing_cycle', periodKeys),
      supabase.from('landlords').select('id, ba_id').in('ba_id', baIds),
      supabase.from('properties').select('id, ba_id').in('ba_id', baIds),
    ]);
  if (earningsErr) throw earningsErr;
  if (rosterErr) throw rosterErr;
  if (propRosterErr) throw propRosterErr;

  const onboardedCountByBa = new Map();
  for (const l of landlordRoster || []) {
    onboardedCountByBa.set(l.ba_id, (onboardedCountByBa.get(l.ba_id) || 0) + 1);
  }
  for (const p of propertyRoster || []) {
    onboardedCountByBa.set(p.ba_id, (onboardedCountByBa.get(p.ba_id) || 0) + 1);
  }

  const key = (baId, periodKey) => `${baId}:${periodKey}`;
  const owedByPair = new Map();
  for (const e of earnings || []) {
    const k = key(e.ba_id, e.billing_cycle);
    const existing = owedByPair.get(k);
    const commission = Number(e.commission_amount || 0);
    if (existing) {
      existing.owedRaw += commission;
      existing.percentageApplied = Number(e.percentage_applied);
    } else {
      owedByPair.set(k, { owedRaw: commission, percentageApplied: Number(e.percentage_applied) });
    }
  }

  const result = new Map();
  for (const { baId, periodKey } of pairs) {
    const k = key(baId, periodKey);
    const owed = owedByPair.get(k);
    result.set(k, {
      owedAmount: truncateKes(owed ? owed.owedRaw : 0),
      percentageApplied: owed ? owed.percentageApplied : null,
      landlordsOnboarded: onboardedCountByBa.get(baId) || 0,
    });
  }
  return result;
}

// ---------------------------------------------------------------------
// Paid cards for one month (periodKey), or across every month with
// paid entries when periodKey is omitted - each card still labeled
// with its own original month. Read-only: no mutation happens here.
// ---------------------------------------------------------------------
async function listCompleted({ periodKey } = {}) {
  let cycleQuery = supabase.from('ba_payout_link_cycles').select('id, period_key');
  if (periodKey) cycleQuery = cycleQuery.eq('period_key', periodKey);
  const { data: cycles, error: cyclesErr } = await cycleQuery;
  if (cyclesErr) throw cyclesErr;
  if (!cycles || cycles.length === 0) return { cards: [], totals: { count: 0, totalAmount: 0 } };

  const cycleById = new Map(cycles.map((c) => [c.id, c]));
  const cycleIds = cycles.map((c) => c.id);

  const { data: submissions, error: subErr } = await supabase
    .from('ba_payment_submissions')
    .select('id, cycle_id, ba_id, mpesa_number, submitted_name, submitted_email, submitted_at, status, paid_at, paid_by_admin_id')
    .in('cycle_id', cycleIds)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false });
  if (subErr) throw subErr;
  if (!submissions || submissions.length === 0) return { cards: [], totals: { count: 0, totalAmount: 0 } };

  const baIds = [...new Set(submissions.map((s) => s.ba_id))];
  const { data: bas, error: baErr } = await supabase
    .from('brand_ambassadors')
    .select('id, full_name, ba_code')
    .in('id', baIds);
  if (baErr) throw baErr;
  const baById = new Map((bas || []).map((b) => [b.id, b]));

  const pairs = submissions.map((s) => ({ baId: s.ba_id, periodKey: cycleById.get(s.cycle_id).period_key }));
  const owedMap = await computeOwedForPairs(pairs);

  const cards = submissions.map((s) => {
    const cycle = cycleById.get(s.cycle_id);
    const ba = baById.get(s.ba_id);
    const owed = owedMap.get(`${s.ba_id}:${cycle.period_key}`) || { owedAmount: 0, percentageApplied: null, landlordsOnboarded: 0 };
    return {
      submissionId: s.id,
      cycleId: s.cycle_id,
      periodKey: cycle.period_key,
      baId: s.ba_id,
      baName: ba ? ba.full_name : s.submitted_name,
      baCode: ba ? ba.ba_code : null,
      mpesaNumber: s.mpesa_number,
      submittedName: s.submitted_name,
      submittedEmail: s.submitted_email,
      landlordsOnboarded: owed.landlordsOnboarded,
      commissionPercentage: owed.percentageApplied,
      amountOwed: owed.owedAmount,
      paidAt: s.paid_at,
      paidByAdminId: s.paid_by_admin_id,
    };
  });

  const totals = cards.reduce(
    (acc, c) => ({ count: acc.count + 1, totalAmount: acc.totalAmount + c.amountOwed }),
    { count: 0, totalAmount: 0 }
  );

  return { cards, totals };
}

module.exports = {
  truncateKes,
  listCompletedPeriods,
  listCompleted,
};
