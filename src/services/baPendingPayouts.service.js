// src/services/baPendingPayouts.service.js
//
// BA Monthly Payment Details & Payout Workflow - Phase 3.
//
// Owns the admin "Pending Payments" view + mark-as-paid:
//   - listPendingPayments()  - one card per unpaid ba_payment_submissions
//     row, across EVERY cycle that still has unpaid entries (not just
//     the current month) - a still-open January card keeps showing up
//     here after February's cycle opens, per the plan. Each card's
//     amount is computed from ba_commission_earnings for that card's
//     OWN period_key (never carried over/merged into a later month),
//     truncated to whole KES. Cards are grouped by identical owed
//     amount, groups ordered by group size (most-shared amount first,
//     unique amounts last).
//   - listAwaitingDetails()  - BAs with qualifying earnings in the
//     CURRENT cycle who haven't submitted payment details yet, so
//     admin doesn't miss them (they have no card at all otherwise).
//   - markPaid()             - bulk-flips selected submissions to
//     status='paid', stamping paid_at/paid_by_admin_id. Works for a
//     single id too.
//
// Reuses the same source of truth as the existing Payout Run report
// (ba_commission_earnings, one row per completed subscription payment
// a qualified landlord's BA earns commission on) rather than
// introducing a second "owed amount" calculation - see
// baPayoutQualificationReport.service.js for the sibling
// implementation this mirrors.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------
// Truncate (never round) to whole KES, per the plan's "Truncate,
// don't round" decision. 12300.89 -> 12300.
// ---------------------------------------------------------------------
function truncateKes(amount) {
  return Math.floor(Number(amount || 0));
}

// ---------------------------------------------------------------------
// For a set of (baId, periodKey) pairs, returns owed-amount +
// landlords-onboarded + a representative commission percentage per
// pair, computed from ba_commission_earnings exactly as the Payout
// Run report does (qualifying landlords' commission_amount, summed
// per BA, for that BA's own cycle only).
// ---------------------------------------------------------------------
async function computeOwedForPairs(pairs) {
  if (!pairs.length) return new Map();

  const baIds = [...new Set(pairs.map((p) => p.baId))];
  const periodKeys = [...new Set(pairs.map((p) => p.periodKey))];

  const [{ data: earnings, error: earningsErr }, { data: landlordRoster, error: rosterErr }, { data: propertyRoster, error: propRosterErr }] =
    await Promise.all([
      supabase
        .from('ba_commission_earnings')
        .select('ba_id, landlord_id, commission_amount, percentage_applied, billing_cycle')
        .in('ba_id', baIds)
        .in('billing_cycle', periodKeys),
      supabase.from('landlords').select('id, ba_id').in('ba_id', baIds),
      supabase.from('properties').select('id, ba_id').in('ba_id', baIds),
    ]);
  if (earningsErr) throw earningsErr;
  if (rosterErr) throw rosterErr;
  if (propRosterErr) throw propRosterErr;

  // Landlords onboarded per BA - mirrors the Payout Run roster count
  // (signup attributions + later property attributions), independent
  // of period_key since "onboarded" is a running roster size, not a
  // per-cycle figure.
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
      // Keep the most recently seen rate as representative when
      // multiple landlords/rates contributed within the same cycle.
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
// Every cycle that currently has at least one 'pending'
// ba_payment_submissions row - not just the active/current-month one.
// ---------------------------------------------------------------------
async function cyclesWithUnpaidEntries() {
  const { data: pendingRows, error: pendingErr } = await supabase
    .from('ba_payment_submissions')
    .select('cycle_id')
    .eq('status', 'pending');
  if (pendingErr) throw pendingErr;

  const cycleIds = [...new Set((pendingRows || []).map((r) => r.cycle_id))];
  if (!cycleIds.length) return [];

  const { data: cycles, error: cyclesErr } = await supabase
    .from('ba_payout_link_cycles')
    .select('id, period_key, status')
    .in('id', cycleIds);
  if (cyclesErr) throw cyclesErr;
  return cycles || [];
}

// ---------------------------------------------------------------------
// The Pending Payments list: one card per unpaid submission, grouped
// by identical (truncated) owed amount, groups ordered largest-group-
// first, singletons (group size 1) at the very bottom. Ties within a
// group are ordered by BA name for stable rendering.
// ---------------------------------------------------------------------
async function listPendingPayments() {
  const cycles = await cyclesWithUnpaidEntries();
  if (!cycles.length) return { groups: [], totalCount: 0 };

  const cycleById = new Map(cycles.map((c) => [c.id, c]));
  const cycleIds = cycles.map((c) => c.id);

  const { data: submissions, error: subErr } = await supabase
    .from('ba_payment_submissions')
    .select('id, cycle_id, ba_id, mpesa_number, submitted_name, submitted_email, submitted_at, status')
    .in('cycle_id', cycleIds)
    .eq('status', 'pending');
  if (subErr) throw subErr;

  if (!submissions || submissions.length === 0) return { groups: [], totalCount: 0 };

  const baIds = [...new Set(submissions.map((s) => s.ba_id))];
  const { data: bas, error: baErr } = await supabase
    .from('brand_ambassadors')
    .select('id, full_name, ba_code, email')
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
      submittedAt: s.submitted_at,
      landlordsOnboarded: owed.landlordsOnboarded,
      commissionPercentage: owed.percentageApplied,
      amountOwed: owed.owedAmount,
    };
  });

  // Group by identical owed amount.
  const byAmount = new Map();
  for (const card of cards) {
    const k = card.amountOwed;
    if (!byAmount.has(k)) byAmount.set(k, []);
    byAmount.get(k).push(card);
  }

  const groups = [...byAmount.entries()]
    .map(([amount, groupCards]) => ({
      amountOwed: amount,
      count: groupCards.length,
      cards: groupCards.sort((a, b) => a.baName.localeCompare(b.baName)),
    }))
    // Largest group first; ties broken by higher amount first so
    // same-size groups still render in a sensible order. Group size 1
    // (unique amounts) naturally fall to the bottom.
    .sort((a, b) => b.count - a.count || b.amountOwed - a.amountOwed);

  return { groups, totalCount: cards.length };
}

// ---------------------------------------------------------------------
// BAs who have qualifying earnings THIS cycle but no submission yet
// this cycle - a lightweight "awaiting details" list so they aren't
// silently missed (they'd otherwise have no card at all).
// ---------------------------------------------------------------------
async function listAwaitingDetails() {
  const { getOrCreateCurrentCycle } = require('./baPayoutLinkCycle.service');
  const currentCycle = await getOrCreateCurrentCycle();

  const { data: earnings, error: earningsErr } = await supabase
    .from('ba_commission_earnings')
    .select('ba_id, commission_amount')
    .eq('billing_cycle', currentCycle.period_key);
  if (earningsErr) throw earningsErr;

  const earningBaIds = [...new Set((earnings || []).map((e) => e.ba_id))];
  if (!earningBaIds.length) return [];

  const { data: submitted, error: subErr } = await supabase
    .from('ba_payment_submissions')
    .select('ba_id')
    .eq('cycle_id', currentCycle.id)
    .in('ba_id', earningBaIds);
  if (subErr) throw subErr;
  const submittedBaIds = new Set((submitted || []).map((s) => s.ba_id));

  const missingBaIds = earningBaIds.filter((id) => !submittedBaIds.has(id));
  if (!missingBaIds.length) return [];

  const { data: bas, error: baErr } = await supabase
    .from('brand_ambassadors')
    .select('id, full_name, ba_code, email, phone')
    .in('id', missingBaIds);
  if (baErr) throw baErr;

  const owedByBa = new Map();
  for (const e of earnings || []) {
    if (!submittedBaIds.has(e.ba_id) && missingBaIds.includes(e.ba_id)) {
      owedByBa.set(e.ba_id, (owedByBa.get(e.ba_id) || 0) + Number(e.commission_amount || 0));
    }
  }

  return (bas || []).map((b) => ({
    baId: b.id,
    baName: b.full_name,
    baCode: b.ba_code,
    email: b.email,
    phone: b.phone,
    periodKey: currentCycle.period_key,
    estimatedAmountOwed: truncateKes(owedByBa.get(b.id) || 0),
  }));
}

// ---------------------------------------------------------------------
// Bulk mark-as-paid. Works for a single id too (array of length 1).
// Only flips rows that are currently 'pending' - already-paid rows or
// unknown ids are silently skipped rather than erroring the whole
// batch.
// ---------------------------------------------------------------------
async function markPaid({ submissionIds, adminId }) {
  const ids = [...new Set((submissionIds || []).filter(Boolean))];
  if (!ids.length) {
    const err = new Error('No submissions selected.');
    err.validation = true;
    throw err;
  }

  const { data, error } = await supabase
    .from('ba_payment_submissions')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      paid_by_admin_id: adminId || null,
    })
    .in('id', ids)
    .eq('status', 'pending')
    .select('id, cycle_id, ba_id, status, paid_at');
  if (error) {
    logger.error('[baPendingPayouts] markPaid error:', error.message);
    throw error;
  }

  return { markedCount: (data || []).length, submissions: data || [] };
}

module.exports = {
  truncateKes,
  listPendingPayments,
  listAwaitingDetails,
  markPaid,
};
