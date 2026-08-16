// src/services/baPendingPayouts.service.js
//
// BUILD SPEC PHASE 10 - Fix: BA Payout Submission Overwrite Bug.
//
// Owns the admin "Pending" tab + mark-as-paid. Payout status now lives
// entirely in `ba_payouts` (one row per BA per calendar period),
// completely decoupled from `ba_payment_submissions` (the BA's
// one-time on-file M-Pesa/name/email). A card is "pending" when a BA
// has qualifying earnings for a period, HAS submitted their payout
// details at least once (payout_submission_used_at set), and there is
// no 'completed' ba_payouts row for that (ba, period) pair yet.
//
// This is the structural half of the bug fix: because payout status
// no longer lives on the same row as the submission, there is no code
// path left by which resubmitting payment details could move a
// completed payout back into this list - resubmission doesn't touch
// ba_payouts at all, and there is no resubmission UI/endpoint anymore
// besides the separate 24h edit link (which also never touches
// ba_payouts).

const supabase = require('../config/supabase');
const logger = require('../utils/logger');

function truncateKes(amount) {
  return Math.floor(Number(amount || 0));
}

function pairKey(baId, periodKey) {
  return `${baId}:${periodKey}`;
}

// ---------------------------------------------------------------------
// Every (ba_id, billing_cycle) pair with qualifying commission
// earnings, with the owed amount + a representative commission % +
// landlords-onboarded count, mirroring the existing Payout Run report
// computation.
// ---------------------------------------------------------------------
async function computeOwedPairs() {
  const { data: earnings, error: earningsErr } = await supabase
    .from('ba_commission_earnings')
    .select('ba_id, commission_amount, percentage_applied, billing_cycle');
  if (earningsErr) throw earningsErr;
  if (!earnings || earnings.length === 0) return new Map();

  const baIds = [...new Set(earnings.map((e) => e.ba_id))];
  const [{ data: landlordRoster, error: rosterErr }, { data: propertyRoster, error: propRosterErr }] = await Promise.all([
    supabase.from('landlords').select('id, ba_id').in('ba_id', baIds),
    supabase.from('properties').select('id, ba_id').in('ba_id', baIds),
  ]);
  if (rosterErr) throw rosterErr;
  if (propRosterErr) throw propRosterErr;

  const onboardedCountByBa = new Map();
  for (const l of landlordRoster || []) {
    onboardedCountByBa.set(l.ba_id, (onboardedCountByBa.get(l.ba_id) || 0) + 1);
  }
  for (const p of propertyRoster || []) {
    onboardedCountByBa.set(p.ba_id, (onboardedCountByBa.get(p.ba_id) || 0) + 1);
  }

  const owedByPair = new Map();
  for (const e of earnings) {
    const k = pairKey(e.ba_id, e.billing_cycle);
    const existing = owedByPair.get(k);
    const commission = Number(e.commission_amount || 0);
    if (existing) {
      existing.owedRaw += commission;
      existing.percentageApplied = Number(e.percentage_applied);
    } else {
      owedByPair.set(k, { baId: e.ba_id, periodKey: e.billing_cycle, owedRaw: commission, percentageApplied: Number(e.percentage_applied) });
    }
  }

  const result = new Map();
  for (const [k, v] of owedByPair.entries()) {
    result.set(k, {
      baId: v.baId,
      periodKey: v.periodKey,
      owedAmount: truncateKes(v.owedRaw),
      percentageApplied: v.percentageApplied,
      landlordsOnboarded: onboardedCountByBa.get(v.baId) || 0,
    });
  }
  return result;
}

// ---------------------------------------------------------------------
// The Pending list: one card per (ba, period) pair with owed > 0, an
// on-file submission, and no completed ba_payouts row yet. Grouped by
// identical owed amount, largest group first (same UX as before).
// ---------------------------------------------------------------------
async function listPendingPayments() {
  const owedPairs = await computeOwedPairs();
  if (owedPairs.size === 0) return { groups: [], totalCount: 0 };

  const baIds = [...new Set([...owedPairs.values()].map((p) => p.baId))];

  const [{ data: bas, error: baErr }, { data: submissions, error: subErr }, { data: completedPayouts, error: payoutErr }] =
    await Promise.all([
      supabase.from('brand_ambassadors').select('id, full_name, ba_code, email, payout_submission_used_at').in('id', baIds),
      supabase.from('ba_payment_submissions').select('ba_id, mpesa_number, submitted_name, submitted_email, submitted_at').in('ba_id', baIds),
      supabase.from('ba_payouts').select('ba_id, period_key').in('ba_id', baIds).eq('status', 'completed'),
    ]);
  if (baErr) throw baErr;
  if (subErr) throw subErr;
  if (payoutErr) throw payoutErr;

  const baById = new Map((bas || []).map((b) => [b.id, b]));
  const submissionByBa = new Map((submissions || []).map((s) => [s.ba_id, s]));
  const completedPairSet = new Set((completedPayouts || []).map((p) => pairKey(p.ba_id, p.period_key)));

  const cards = [];
  for (const pair of owedPairs.values()) {
    if (pair.owedAmount <= 0) continue;
    const ba = baById.get(pair.baId);
    if (!ba || !ba.payout_submission_used_at) continue; // hasn't submitted details yet - not payable via this queue
    const k = pairKey(pair.baId, pair.periodKey);
    if (completedPairSet.has(k)) continue; // already paid - never re-enters pending

    const submission = submissionByBa.get(pair.baId);
    if (!submission) continue;

    cards.push({
      payoutKey: k,
      baId: pair.baId,
      periodKey: pair.periodKey,
      baName: ba.full_name,
      baCode: ba.ba_code,
      mpesaNumber: submission.mpesa_number,
      submittedName: submission.submitted_name,
      submittedEmail: submission.submitted_email,
      submittedAt: submission.submitted_at,
      landlordsOnboarded: pair.landlordsOnboarded,
      commissionPercentage: pair.percentageApplied,
      amountOwed: pair.owedAmount,
    });
  }

  const byAmount = new Map();
  for (const card of cards) {
    if (!byAmount.has(card.amountOwed)) byAmount.set(card.amountOwed, []);
    byAmount.get(card.amountOwed).push(card);
  }

  const groups = [...byAmount.entries()]
    .map(([amount, groupCards]) => ({
      amountOwed: amount,
      count: groupCards.length,
      cards: groupCards.sort((a, b) => a.baName.localeCompare(b.baName)),
    }))
    .sort((a, b) => b.count - a.count || b.amountOwed - a.amountOwed);

  return { groups, totalCount: cards.length };
}

// ---------------------------------------------------------------------
// BAs with qualifying earnings THIS period who haven't submitted
// payout details at all yet - so admin doesn't miss them (they'd
// otherwise have no card, since a card requires an on-file submission).
// ---------------------------------------------------------------------
async function listAwaitingDetails() {
  const { currentPeriodKey } = require('./baPayoutLinkCycle.service');
  const { submissionLink } = require('./baPayoutSubmissionLink.service');
  const currentPeriod = currentPeriodKey();

  const { data: earnings, error: earningsErr } = await supabase
    .from('ba_commission_earnings')
    .select('ba_id, commission_amount')
    .eq('billing_cycle', currentPeriod);
  if (earningsErr) throw earningsErr;

  const earningBaIds = [...new Set((earnings || []).map((e) => e.ba_id))];
  if (!earningBaIds.length) return [];

  const { data: bas, error: baErr } = await supabase
    .from('brand_ambassadors')
    .select('id, full_name, ba_code, email, phone, payout_submission_used_at')
    .in('id', earningBaIds);
  if (baErr) throw baErr;

  const notSubmitted = (bas || []).filter((b) => !b.payout_submission_used_at);
  if (!notSubmitted.length) return [];

  const owedByBa = new Map();
  for (const e of earnings || []) {
    owedByBa.set(e.ba_id, (owedByBa.get(e.ba_id) || 0) + Number(e.commission_amount || 0));
  }

  return notSubmitted.map((b) => ({
    baId: b.id,
    baName: b.full_name,
    baCode: b.ba_code,
    email: b.email,
    phone: b.phone,
    periodKey: currentPeriod,
    estimatedAmountOwed: truncateKes(owedByBa.get(b.id) || 0),
    // BUILD SPEC PHASE 10 (v2): the submission link is now one static,
    // universal URL, the same for every BA - always available to
    // share, never per-person.
    hasSubmissionLink: true,
    submissionLink: submissionLink(),
  }));
}

// ---------------------------------------------------------------------
// Mark selected (ba, period) pairs as paid. Upserts into ba_payouts -
// but ONLY ever moves a row from 'pending'/nonexistent to 'completed'.
// A pair whose row is already 'completed' is silently skipped (not
// re-processed, not re-paid) - this is the guarantee that a completed
// payout can never be re-marked or overwritten.
// ---------------------------------------------------------------------
async function markPaid({ payoutKeys, adminId }) {
  const keys = [...new Set((payoutKeys || []).filter(Boolean))];
  if (!keys.length) {
    const err = new Error('No payments selected.');
    err.validation = true;
    throw err;
  }

  const pairs = keys.map((k) => {
    const idx = k.lastIndexOf(':');
    return { key: k, baId: k.slice(0, idx), periodKey: k.slice(idx + 1) };
  });

  const owedPairs = await computeOwedPairs();
  const baIds = pairs.map((p) => p.baId);
  const { data: existingPayouts, error: existingErr } = await supabase
    .from('ba_payouts')
    .select('id, ba_id, period_key, status')
    .in('ba_id', baIds);
  if (existingErr) throw existingErr;
  const existingByPair = new Map((existingPayouts || []).map((p) => [pairKey(p.ba_id, p.period_key), p]));

  const now = new Date().toISOString();
  const paidSubmissions = [];

  for (const { key, baId, periodKey } of pairs) {
    const existing = existingByPair.get(key);
    if (existing && existing.status === 'completed') continue; // never re-mark

    const owed = owedPairs.get(key);
    const amount = owed ? owed.owedAmount : 0;

    if (existing) {
      const { error } = await supabase
        .from('ba_payouts')
        .update({ status: 'completed', amount, paid_at: now, paid_by_admin_id: adminId || null })
        .eq('id', existing.id)
        .eq('status', 'pending'); // guard: only flips a still-pending row
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('ba_payouts')
        .insert({ ba_id: baId, period_key: periodKey, status: 'completed', amount, paid_at: now, paid_by_admin_id: adminId || null });
      if (error && error.code !== '23505') throw error; // 23505 = raced with another insert, safe to ignore
    }
    paidSubmissions.push({ baId, periodKey, amount });
  }

  return { markedCount: paidSubmissions.length, payouts: paidSubmissions };
}

module.exports = {
  truncateKes,
  listPendingPayments,
  listAwaitingDetails,
  markPaid,
};
