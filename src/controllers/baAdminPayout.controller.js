// src/controllers/baAdminPayout.controller.js
//
// BUILD SPEC PHASE 11 - Admin: Payout Review, Reconciliation &
// Cross-BA Security Report.
//
// REBUILT (bugfix, post Section E/F/G cutover): this controller
// originally read `ba_landlord_claims` (payout_amount /
// commission_bonus_amount / commission_tier_id snapshots) and joined
// against `commission_tiers` / `unit_pricing_tiers`. All three tables
// were dropped by 2026-08-remove-manual-ba-claims.sql and
// 2026-08-section-e-recurring-percentage-commission.sql, which left
// every endpoint below throwing "relation does not exist" the moment
// it was hit - see that migration's own closing comment flagging this
// exact rebuild as still outstanding.
//
// Source of truth now: `ba_commission_earnings` (Section E -
// baCommission.service.js writes one row per completed landlord
// subscription payment, already carrying the snapshotted
// payment_amount / percentage_applied / commission_amount /
// billing_cycle - never recomputed at read time here), joined against
// `landlords` (name/location/roster/qualification) and
// `brand_ambassadors`. This mirrors exactly the source
// baPayoutQualificationReport.service.js (Section F/G, already
// working) reads from, so the two screens can never disagree.
//
// Money & Data Integrity Rules: every $ total below is either a raw
// sum of ba_commission_earnings.commission_amount (an immutable
// snapshot written at payment time) or a total stored on
// ba_payout_period_marks at the moment admin marked a period paid -
// never recomputed from a live rate at read time.
//
// Part A - getPayoutReview / markBaPeriodPaid / markBaPeriodNotPaid:
//   a period-scoped view of every BA's owed total, built from
//   ba_commission_earnings rows whose paid_at falls in the selected
//   week/month. Percentage commission is now the ONLY payout model
//   (Section E hard cutover - there is no separate flat "base" amount
//   any more), so baseTotal is always 0 and commissionTotal IS the
//   total owed; both fields are kept on the response so the existing
//   frontend (which renders "Base: X / Commission: Y / Total: Z")
//   keeps working unchanged. "Mark as Paid" is made idempotent via
//   ba_payout_period_marks' unique (ba_id, period_type, period_key)
//   constraint, same as before - only the claim_ids column now holds
//   ba_commission_earnings ids instead of ba_landlord_claims ids (the
//   column name is unchanged; earnings rows are never themselves
//   mutated - the mark row IS the paid/not-paid record).
//
// Part B - reconcileBaList: rebuilt against `landlords` directly
// (there is no more separate "claim" a BA submits by hand - a
// landlord is attached to a BA only via the referral link/code at
// signup, same model change Part C below already went through). The
// "edited after submission" bucket has no equivalent any more (no
// edit_history exists on landlords) and is marked `retired: true`,
// same convention Part C already uses for its two retired signals.
//
// Part C - getBaSecurityReport: unchanged - already rebuilt against
// `landlords` in an earlier fix and does not touch any dropped table.
//
// Period convention: 'month' -> 'YYYY-MM', 'week' -> the Monday-start
// date of that week as 'YYYY-MM-DD' - the exact same shape as
// brandAmbassador.controller.js's weekKey()/monthKey() helpers (Phase
// 5 stats), duplicated locally here since every controller in this
// codebase defines its own small date helpers rather than sharing a
// utils module for this (see that file's own comment on the
// convention).

const supabase = require('../config/supabase');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const { normalizePhoneOrThrow } = require('../utils/phone');
const { generateEarningsStatementPdf } = require('../services/pdfReport.service');
const { notify } = require('../services/notify.service');
const logger = require('../utils/logger');

const ADMIN_ACTOR_ID = 'super-admin';

// ---------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------

function periodRange(periodType, periodKey) {
  if (periodType === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(String(periodKey || ''));
    if (!m) throw new Error('periodKey for a month period must be "YYYY-MM".');
    const year = Number(m[1]);
    const month = Number(m[2]);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    return { start, end };
  }
  if (periodType === 'week') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(periodKey || ''));
    if (!m) throw new Error('periodKey for a week period must be the Monday date "YYYY-MM-DD".');
    const start = new Date(`${periodKey}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) throw new Error('Invalid week periodKey.');
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { start, end };
  }
  throw new Error('periodType must be "week" or "month".');
}

function validatePeriodParams(periodType, periodKey) {
  if (!['week', 'month'].includes(periodType)) {
    return 'periodType must be "week" or "month".';
  }
  if (!periodKey) return 'periodKey is required.';
  return null;
}

// =======================================================================
// PART A - Payout Review
// =======================================================================

async function getPayoutReview(req, res) {
  try {
    const { periodType, periodKey } = req.query;
    const validationError = validatePeriodParams(periodType, periodKey);
    if (validationError) return res.status(400).json({ error: validationError });

    let range;
    try {
      range = periodRange(periodType, periodKey);
    } catch (rangeErr) {
      return res.status(400).json({ error: rangeErr.message });
    }

    const { data: bas, error: baErr } = await supabase
      .from('brand_ambassadors')
      .select('id, ba_code, full_name, phone, email, status')
      .order('full_name', { ascending: true });
    if (baErr) throw baErr;

    const { data: earnings, error: earningsErr } = await supabase
      .from('ba_commission_earnings')
      .select(
        'id, ba_id, landlord_id, payment_amount, percentage_applied, commission_amount, paid_at, landlords(full_name, county)'
      )
      .gte('paid_at', range.start.toISOString())
      .lt('paid_at', range.end.toISOString())
      .order('paid_at', { ascending: true });
    if (earningsErr) throw earningsErr;

    const { data: mark, error: markErr } = await supabase
      .from('ba_payout_period_marks')
      .select('ba_id, status, claim_ids, marked_paid_by, marked_paid_at')
      .eq('period_type', periodType)
      .eq('period_key', periodKey);
    if (markErr) throw markErr;
    const markByBa = new Map((mark || []).map((m) => [m.ba_id, m]));

    const earningsByBa = new Map();
    for (const e of earnings || []) {
      if (!earningsByBa.has(e.ba_id)) earningsByBa.set(e.ba_id, []);
      earningsByBa.get(e.ba_id).push(e);
    }

    const baIds = (bas || []).map((b) => b.id);
    const rosterCountByBa = new Map();
    const qualifyingCountByBa = new Map();
    if (baIds.length > 0) {
      const { data: rosterLandlords, error: rosterErr } = await supabase
        .from('landlords')
        .select('id, ba_id, ba_qualification_status')
        .in('ba_id', baIds);
      if (rosterErr) throw rosterErr;

      for (const l of rosterLandlords || []) {
        rosterCountByBa.set(l.ba_id, (rosterCountByBa.get(l.ba_id) || 0) + 1);
        if (l.ba_qualification_status === 'qualified') {
          qualifyingCountByBa.set(l.ba_id, (qualifyingCountByBa.get(l.ba_id) || 0) + 1);
        }
      }
    }

    const { data: overrideRates } = await supabase
      .from('payout_rules')
      .select('ba_id, percentage, effective_from')
      .eq('scope', 'ba_override')
      .lte('effective_from', new Date().toISOString())
      .order('effective_from', { ascending: false });
    const currentOverrideByBa = new Map();
    for (const r of overrideRates || []) {
      if (!currentOverrideByBa.has(r.ba_id)) currentOverrideByBa.set(r.ba_id, Number(r.percentage));
    }
    const { data: globalRateRows } = await supabase
      .from('payout_rules')
      .select('percentage, effective_from')
      .eq('scope', 'global')
      .lte('effective_from', new Date().toISOString())
      .order('effective_from', { ascending: false })
      .limit(1);
    const currentGlobalRate = globalRateRows && globalRateRows.length > 0 ? Number(globalRateRows[0].percentage) : 0;

    const rows = (bas || [])
      .map((ba) => {
        const baEarnings = earningsByBa.get(ba.id) || [];
        const baseTotal = 0;
        const commissionTotal = baEarnings.reduce((sum, e) => sum + Number(e.commission_amount || 0), 0);
        const periodMark = markByBa.get(ba.id) || null;
        const paidEarningIds = new Set(periodMark && periodMark.status === 'paid' ? periodMark.claim_ids || [] : []);
        const totalLandlordsOnboarded = rosterCountByBa.get(ba.id) || 0;
        const qualifyingLandlords = qualifyingCountByBa.get(ba.id) || 0;
        const notQualifyingLandlords = Math.max(0, totalLandlordsOnboarded - qualifyingLandlords);

        return {
          ba: {
            id: ba.id,
            baCode: ba.ba_code,
            fullName: ba.full_name,
            phone: ba.phone,
            email: ba.email,
            status: ba.status,
            currentCommissionPercent: currentOverrideByBa.has(ba.id) ? currentOverrideByBa.get(ba.id) : currentGlobalRate,
          },
          claims: baEarnings.map((e) => ({
            id: e.id,
            landlordName: e.landlords?.full_name || 'Unknown',
            landlordLocation: e.landlords?.county || null,
            qualificationStatus: paidEarningIds.has(e.id) ? 'paid' : 'qualified',
            qualifiedAt: e.paid_at,
            payoutAmount: 0,
            commissionBonusAmount: Number(e.commission_amount || 0),
            markedPaidBy: paidEarningIds.has(e.id) ? periodMark.marked_paid_by : null,
            markedPaidAt: paidEarningIds.has(e.id) ? periodMark.marked_paid_at : null,
          })),
          baseTotal,
          commissionTotal,
          grandTotal: baseTotal + commissionTotal,
          periodMarkedStatus: periodMark ? periodMark.status : null,
          totalLandlordsOnboarded,
          qualifyingLandlords,
          notQualifyingLandlords,
          commissionRatePercent: currentOverrideByBa.has(ba.id) ? currentOverrideByBa.get(ba.id) : currentGlobalRate,
        };
      })
      .filter((row) => row.claims.length > 0 || row.totalLandlordsOnboarded > 0);

    const runTotals = rows.reduce(
      (acc, row) => ({
        landlordsOnboarded: acc.landlordsOnboarded + row.totalLandlordsOnboarded,
        qualifying: acc.qualifying + row.qualifyingLandlords,
        notQualifying: acc.notQualifying + row.notQualifyingLandlords,
        amountOwed: acc.amountOwed + row.grandTotal,
      }),
      { landlordsOnboarded: 0, qualifying: 0, notQualifying: 0, amountOwed: 0 }
    );

    return res.json({ periodType, periodKey, bas: rows, runTotals });
  } catch (err) {
    logger.error('[baAdminPayout] getPayoutReview error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the payout review.' });
  }
}

async function markBaPeriod(req, res, targetStatus) {
  try {
    const { baId } = req.params;
    const { periodType, periodKey, claimIds: earningIds } = req.body;

    const validationError = validatePeriodParams(periodType, periodKey);
    if (validationError) return res.status(400).json({ error: validationError });
    if (!Array.isArray(earningIds) || earningIds.length === 0) {
      return res.status(400).json({ error: 'claimIds is required.' });
    }

    let range;
    try {
      range = periodRange(periodType, periodKey);
    } catch (rangeErr) {
      return res.status(400).json({ error: rangeErr.message });
    }

    const { data: existingMark, error: markFetchErr } = await supabase
      .from('ba_payout_period_marks')
      .select('*')
      .eq('ba_id', baId)
      .eq('period_type', periodType)
      .eq('period_key', periodKey)
      .maybeSingle();
    if (markFetchErr) throw markFetchErr;

    if (targetStatus === 'paid' && existingMark && existingMark.status === 'paid') {
      return res.json({ mark: existingMark, alreadyPaid: true });
    }

    const { data: earnings, error: earningsErr } = await supabase
      .from('ba_commission_earnings')
      .select('id, ba_id, paid_at, commission_amount')
      .in('id', earningIds);
    if (earningsErr) throw earningsErr;

    if ((earnings || []).length !== earningIds.length) {
      return res.status(400).json({ error: 'One or more earning ids were not found.' });
    }
    for (const e of earnings) {
      if (e.ba_id !== baId) return res.status(400).json({ error: `Earning ${e.id} does not belong to this Brand Ambassador.` });
      if (!e.paid_at || new Date(e.paid_at) < range.start || new Date(e.paid_at) >= range.end) {
        return res.status(400).json({ error: `Earning ${e.id} does not fall in the selected period.` });
      }
    }

    const baseTotal = 0;
    const commissionTotal = earnings.reduce((sum, e) => sum + Number(e.commission_amount || 0), 0);
    const nowIso = new Date().toISOString();

    const markPayload = {
      ba_id: baId,
      period_type: periodType,
      period_key: periodKey,
      status: targetStatus,
      claim_ids: earningIds,
      base_total: baseTotal,
      commission_total: commissionTotal,
      grand_total: baseTotal + commissionTotal,
      marked_paid_by: targetStatus === 'paid' ? ADMIN_ACTOR_ID : null,
      marked_paid_at: targetStatus === 'paid' ? nowIso : null,
      updated_at: nowIso,
    };

    let mark;
    if (existingMark) {
      const { data, error } = await supabase.from('ba_payout_period_marks').update(markPayload).eq('id', existingMark.id).select().single();
      if (error) throw error;
      mark = data;
    } else {
      const { data, error } = await supabase.from('ba_payout_period_marks').insert(markPayload).select().single();
      if (error) {
        if (error.code === '23505') {
          const { data: raced } = await supabase
            .from('ba_payout_period_marks')
            .select('*')
            .eq('ba_id', baId)
            .eq('period_type', periodType)
            .eq('period_key', periodKey)
            .maybeSingle();
          return res.json({ mark: raced, alreadyPaid: true });
        }
        throw error;
      }
      mark = data;
    }

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: targetStatus === 'paid' ? 'ba_payout_period_marked_paid' : 'ba_payout_period_marked_not_paid',
      targetType: 'brand_ambassador',
      targetId: baId,
      ipAddress: req.ip,
      metadata: { periodType, periodKey, earningIds, baseTotal, commissionTotal },
    });

    if (targetStatus === 'paid') {
      const grandTotal = baseTotal + commissionTotal;
      const count = earnings.length;
      try {
        await notify(
          'brand_ambassador',
          baId,
          null,
          `You've been paid KES ${grandTotal.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} for ${count} qualifying landlord${count === 1 ? '' : 's'} this ${periodType === 'week' ? 'week' : 'month'}.`,
          { category: 'account', title: 'You have been paid' }
        );
      } catch (notifyErr) {
        logger.error('[baAdminPayout] markBaPeriod: paid notification failed:', notifyErr.message);
        captureException(notifyErr);
      }
    }

    return res.json({ mark });
  } catch (err) {
    logger.error(`[baAdminPayout] markBaPeriod(${targetStatus}) error:`, err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update this payout period.' });
  }
}

const markBaPeriodPaid = (req, res) => markBaPeriod(req, res, 'paid');
const markBaPeriodNotPaid = (req, res) => markBaPeriod(req, res, 'not_paid');

async function downloadBaPayoutStatement(req, res) {
  try {
    const { baId } = req.params;
    const { periodType, periodKey } = req.query;
    const validationError = validatePeriodParams(periodType, periodKey);
    if (validationError) return res.status(400).json({ error: validationError });

    let range;
    try {
      range = periodRange(periodType, periodKey);
    } catch (rangeErr) {
      return res.status(400).json({ error: rangeErr.message });
    }

    const { data: ba, error: baErr } = await supabase
      .from('brand_ambassadors')
      .select('id, ba_code, full_name')
      .eq('id', baId)
      .maybeSingle();
    if (baErr) throw baErr;
    if (!ba) return res.status(404).json({ error: 'Brand Ambassador not found.' });

    const { data: mark } = await supabase
      .from('ba_payout_period_marks')
      .select('status, claim_ids, marked_paid_at')
      .eq('ba_id', baId)
      .eq('period_type', periodType)
      .eq('period_key', periodKey)
      .maybeSingle();
    const paidEarningIds = new Set(mark && mark.status === 'paid' ? mark.claim_ids || [] : []);

    const { data: earnings, error: earningsErr } = await supabase
      .from('ba_commission_earnings')
      .select('id, paid_at, commission_amount, landlords(full_name)')
      .eq('ba_id', baId)
      .gte('paid_at', range.start.toISOString())
      .lt('paid_at', range.end.toISOString())
      .order('paid_at', { ascending: true });
    if (earningsErr) throw earningsErr;

    const rows = earnings || [];
    const lines = [['Landlord', 'Paid At', 'Base Payout (KES)', 'Commission Bonus (KES)', 'Status', 'Marked Paid At'].join(',')];
    let commissionTotal = 0;
    for (const e of rows) {
      const name = (e.landlords?.full_name || 'Unknown').replace(/"/g, '""');
      commissionTotal += Number(e.commission_amount || 0);
      const isPaid = paidEarningIds.has(e.id);
      lines.push(
        [`"${name}"`, e.paid_at || '', '0.00', Number(e.commission_amount || 0).toFixed(2), isPaid ? 'paid' : 'qualified', isPaid ? mark.marked_paid_at || '' : ''].join(',')
      );
    }
    lines.push('');
    lines.push(`Base Total,,0.00`);
    lines.push(`Commission Total,,,${commissionTotal.toFixed(2)}`);
    lines.push(`Grand Total,,,,${commissionTotal.toFixed(2)}`);

    const filename = `statement-${ba.ba_code || ba.id}-${periodKey}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(lines.join('\n'));
  } catch (err) {
    logger.error('[baAdminPayout] downloadBaPayoutStatement error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate the statement.' });
  }
}

function statementPeriodRange(periodType, periodKey, from, to) {
  if (periodType === 'month') {
    const range = periodRange('month', periodKey);
    return { ...range, label: periodKey };
  }
  if (periodType === 'custom') {
    if (!from || !to) throw new Error('from and to are required for a custom period.');
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error('Invalid custom date range.');
    }
    end.setUTCDate(end.getUTCDate() + 1);
    if (start >= end) throw new Error('The "from" date must be before the "to" date.');
    return { start, end, label: `${from}_to_${to}` };
  }
  throw new Error('periodType must be "month" or "custom".');
}

async function fetchEarningsStatementData(baId, range) {
  const { data: ba, error: baErr } = await supabase
    .from('brand_ambassadors')
    .select('id, ba_code, full_name, phone, email')
    .eq('id', baId)
    .maybeSingle();
  if (baErr) throw baErr;
  if (!ba) return null;

  const { data: earnings, error: earningsErr } = await supabase
    .from('ba_commission_earnings')
    .select('id, payment_amount, percentage_applied, commission_amount, paid_at, landlords(full_name, county)')
    .eq('ba_id', baId)
    .gte('paid_at', range.start.toISOString())
    .lt('paid_at', range.end.toISOString())
    .order('paid_at', { ascending: true });
  if (earningsErr) throw earningsErr;

  const { data: marks } = await supabase
    .from('ba_payout_period_marks')
    .select('status, claim_ids, marked_paid_at, marked_paid_by')
    .eq('ba_id', baId)
    .eq('status', 'paid');
  const paidMeta = new Map();
  for (const m of marks || []) {
    for (const id of m.claim_ids || []) {
      paidMeta.set(id, { markedPaidAt: m.marked_paid_at, markedPaidBy: m.marked_paid_by });
    }
  }

  const rows = (earnings || []).map((e) => {
    const paid = paidMeta.get(e.id);
    return {
      id: e.id,
      landlordName: e.landlords?.full_name || 'Unknown',
      landlordLocation: e.landlords?.county || '',
      qualifiedAt: e.paid_at,
      payoutAmount: 0,
      commissionBonusAmount: Number(e.commission_amount || 0),
      commissionTierId: null,
      status: paid ? 'paid' : 'qualified',
      markedPaidAt: paid ? paid.markedPaidAt : null,
      markedPaidBy: paid ? paid.markedPaidBy : null,
      breakdown: {
        unitCount: null,
        unitBracket: null,
        percentage: { rate: Number(e.percentage_applied || 0), basisAmount: Number(e.payment_amount || 0) },
        commissionTier: null,
      },
    };
  });

  const totals = {
    baseTotal: 0,
    commissionTotal: 0,
    grandTotal: 0,
    paidBaseTotal: 0,
    paidCommissionTotal: 0,
    paidTotal: 0,
    qualifiedNotYetPaidBaseTotal: 0,
    qualifiedNotYetPaidCommissionTotal: 0,
    qualifiedNotYetPaidTotal: 0,
  };
  for (const r of rows) {
    totals.commissionTotal += r.commissionBonusAmount;
    if (r.status === 'paid') {
      totals.paidCommissionTotal += r.commissionBonusAmount;
    } else {
      totals.qualifiedNotYetPaidCommissionTotal += r.commissionBonusAmount;
    }
  }
  totals.grandTotal = totals.baseTotal + totals.commissionTotal;
  totals.paidTotal = totals.paidBaseTotal + totals.paidCommissionTotal;
  totals.qualifiedNotYetPaidTotal = totals.qualifiedNotYetPaidBaseTotal + totals.qualifiedNotYetPaidCommissionTotal;

  return { ba, claims: rows, totals };
}

function buildEarningsStatementCsv(ba, claims, totals, periodLabel) {
  const lines = [
    ['Landlord', 'Location', 'Units', 'Base Payout Basis', 'Qualified At', 'Base Payout (KES)', 'Commission Tier', 'Commission Bonus (KES)', 'Status', 'Paid At'].join(','),
  ];
  for (const c of claims) {
    const name = String(c.landlordName || '').replace(/"/g, '""');
    const location = String(c.landlordLocation || '').replace(/"/g, '""');
    const payoutBasis = c.breakdown?.percentage
      ? `${c.breakdown.percentage.rate}% of KES ${Number(c.breakdown.percentage.basisAmount).toFixed(2)} qualifying payment`
      : 'Flat rate';
    lines.push(
      [
        `"${name}"`,
        `"${location}"`,
        '',
        `"${payoutBasis}"`,
        c.qualifiedAt || '',
        c.payoutAmount.toFixed(2),
        '"None"',
        c.commissionBonusAmount.toFixed(2),
        c.status,
        c.markedPaidAt || '',
      ].join(',')
    );
  }
  lines.push('');
  lines.push(`Period,${periodLabel}`);
  lines.push(`Base Total,${totals.baseTotal.toFixed(2)}`);
  lines.push(`Commission Total,${totals.commissionTotal.toFixed(2)}`);
  lines.push(`Grand Total,${totals.grandTotal.toFixed(2)}`);
  lines.push(`Already Paid,${totals.paidTotal.toFixed(2)}`);
  lines.push(`Qualified Not Yet Paid,${totals.qualifiedNotYetPaidTotal.toFixed(2)}`);
  return lines.join('\n');
}

function parseStatementQuery(req) {
  const { periodType, periodKey, from, to } = req.query;
  return statementPeriodRange(periodType, periodKey, from, to);
}

async function getBaEarningsStatement(req, res) {
  try {
    const baId = req.params.baId || req.user.id;

    let range;
    try {
      range = parseStatementQuery(req);
    } catch (rangeErr) {
      return res.status(400).json({ error: rangeErr.message });
    }

    const statement = await fetchEarningsStatementData(baId, range);
    if (!statement) return res.status(404).json({ error: 'Brand Ambassador not found.' });

    return res.json({
      baCode: statement.ba.ba_code,
      fullName: statement.ba.full_name,
      phone: statement.ba.phone,
      email: statement.ba.email,
      period: range.label,
      claims: statement.claims,
      totals: statement.totals,
    });
  } catch (err) {
    logger.error('[baAdminPayout] getBaEarningsStatement error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the earnings statement.' });
  }
}

async function downloadBaEarningsStatement(req, res, format) {
  try {
    const baId = req.params.baId || req.user.id;

    let range;
    try {
      range = parseStatementQuery(req);
    } catch (rangeErr) {
      return res.status(400).json({ error: rangeErr.message });
    }

    const statement = await fetchEarningsStatementData(baId, range);
    if (!statement) return res.status(404).json({ error: 'Brand Ambassador not found.' });

    const filenameBase = `statement-${statement.ba.ba_code || statement.ba.id}-${range.label}`;

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
      return res.send(buildEarningsStatementCsv(statement.ba, statement.claims, statement.totals, range.label));
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
    generateEarningsStatementPdf(res, {
      ba: statement.ba,
      claims: statement.claims,
      totals: statement.totals,
      periodLabel: range.label,
      generatedAt: new Date(),
    });
  } catch (err) {
    logger.error(`[baAdminPayout] downloadBaEarningsStatement(${format}) error:`, err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate the statement.' });
  }
}

const downloadBaEarningsStatementPdf = (req, res) => downloadBaEarningsStatement(req, res, 'pdf');
const downloadBaEarningsStatementCsv = (req, res) => downloadBaEarningsStatement(req, res, 'csv');

const PHONE_TOKEN_RE = /(\+?\d[\d\s-]{7,14}\d)/;

function parsePastedList(pastedText) {
  const lines = String(pastedText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const m = PHONE_TOKEN_RE.exec(line);
    const phoneRaw = m ? m[0].trim() : null;
    let name = phoneRaw ? line.replace(phoneRaw, '') : line;
    name = name.replace(/^[\s\-,:;|.]+|[\s\-,:;|.]+$/g, '').trim() || null;

    let normalizedPhone = null;
    if (phoneRaw) {
      try {
        normalizedPhone = normalizePhoneOrThrow(phoneRaw, 'Phone number');
      } catch {
        normalizedPhone = null;
      }
    }

    return { raw: line, name, phoneRaw, normalizedPhone };
  });
}

async function reconcileBaList(req, res) {
  try {
    const { baId, date, pastedText } = req.body;
    if (!baId || !date || !pastedText || !String(pastedText).trim()) {
      return res.status(400).json({ error: 'baId, date, and pastedText are all required.' });
    }

    const dayStart = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(dayStart.getTime())) return res.status(400).json({ error: 'Invalid date.' });
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const { data: ba, error: baErr } = await supabase.from('brand_ambassadors').select('id, ba_code, full_name').eq('id', baId).maybeSingle();
    if (baErr) throw baErr;
    if (!ba) return res.status(404).json({ error: 'Brand Ambassador not found.' });

    const { data: landlordRows, error: landlordsErr } = await supabase
      .from('landlords')
      .select('id, full_name, phone, created_at')
      .eq('ba_id', baId)
      .gte('created_at', dayStart.toISOString())
      .lt('created_at', dayEnd.toISOString());
    if (landlordsErr) throw landlordsErr;

    const onboardedRows = landlordRows || [];
    const parsedEntries = parsePastedList(pastedText);

    const matchedInSystem = [];
    const claimedButMissingFromSystem = [];
    const matchedLandlordIds = new Set();

    for (const entry of parsedEntries) {
      const match = entry.normalizedPhone ? onboardedRows.find((l) => l.phone === entry.normalizedPhone) : null;
      if (match) {
        matchedInSystem.push({ pasted: entry, landlord: { id: match.id, name: match.full_name, phone: match.phone } });
        matchedLandlordIds.add(match.id);
      } else {
        claimedButMissingFromSystem.push(entry);
      }
    }

    return res.json({
      ba: { id: ba.id, baCode: ba.ba_code, fullName: ba.full_name },
      date,
      matchedInSystem,
      claimedButMissingFromSystem,
      editedAfterSubmission: [],
      editedAfterSubmissionRetired: true,
      editedAfterSubmissionRetiredReason:
        'Manual claim editing was removed along with ba_landlord_claims - a landlord record has no submission history to compare against any more.',
      counts: {
        matched: matchedInSystem.length,
        missing: claimedButMissingFromSystem.length,
        edited: 0,
        totalPasted: parsedEntries.length,
        totalOnboardedThatDay: onboardedRows.length,
      },
    });
  } catch (err) {
    logger.error('[baAdminPayout] reconcileBaList error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to reconcile the pasted list.' });
  }
}

const SECURITY_REPORT_WINDOW_DAYS = parseInt(process.env.BA_SECURITY_REPORT_WINDOW_DAYS || '30', 10);
const RAPID_FIRE_WINDOW_MINUTES = parseInt(process.env.BA_RAPID_FIRE_WINDOW_MINUTES || '60', 10);
const RAPID_FIRE_THRESHOLD = parseInt(process.env.BA_RAPID_FIRE_THRESHOLD || '5', 10);

function findRapidFireCluster(rowsAsc, windowMs, threshold) {
  let windowStart = 0;
  let best = null;
  for (let i = 0; i < rowsAsc.length; i++) {
    while (new Date(rowsAsc[i].created_at) - new Date(rowsAsc[windowStart].created_at) > windowMs) windowStart++;
    const size = i - windowStart + 1;
    if (size >= threshold && (!best || size > best.count)) {
      best = {
        count: size,
        landlordIds: rowsAsc.slice(windowStart, i + 1).map((c) => c.id),
        from: rowsAsc[windowStart].created_at,
        to: rowsAsc[i].created_at,
      };
    }
  }
  return best;
}

async function getBaSecurityReport(req, res) {
  try {
    const windowStart = new Date();
    windowStart.setUTCDate(windowStart.getUTCDate() - SECURITY_REPORT_WINDOW_DAYS);

    const { data: landlordRows, error: landlordsErr } = await supabase
      .from('landlords')
      .select('id, full_name, ba_id, ba_attribution_disputed, ba_attribution_disputed_at, created_at, brand_ambassadors(full_name, ba_code, status)')
      .not('ba_id', 'is', null)
      .gte('created_at', windowStart.toISOString())
      .order('created_at', { ascending: true });
    if (landlordsErr) throw landlordsErr;

    const rows = landlordRows || [];

    const byBa = new Map();
    for (const l of rows) {
      if (!byBa.has(l.ba_id)) byBa.set(l.ba_id, []);
      byBa.get(l.ba_id).push(l);
    }
    const windowMs = RAPID_FIRE_WINDOW_MINUTES * 60 * 1000;
    const rapidFireOnboarding = [];
    for (const [baId, list] of byBa) {
      const cluster = findRapidFireCluster(list, windowMs, RAPID_FIRE_THRESHOLD);
      if (cluster) {
        rapidFireOnboarding.push({
          baId,
          baName: list[0].brand_ambassadors?.full_name || null,
          landlordIds: cluster.landlordIds,
          count: cluster.count,
          windowMinutes: RAPID_FIRE_WINDOW_MINUTES,
          from: cluster.from,
          to: cluster.to,
        });
      }
    }

    const disputedAttributions = rows
      .filter((l) => l.ba_attribution_disputed)
      .map((l) => ({
        landlordId: l.id,
        landlordName: l.full_name,
        baId: l.ba_id,
        baName: l.brand_ambassadors?.full_name || null,
        disputedAt: l.ba_attribution_disputed_at,
      }));

    return res.json({
      windowDays: SECURITY_REPORT_WINDOW_DAYS,
      rapidFireOnboarding,
      disputedAttributions,
    });
  } catch (err) {
    logger.error('[baAdminPayout] getBaSecurityReport error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the BA security report.' });
  }
}

module.exports = {
  getPayoutReview,
  markBaPeriodPaid,
  markBaPeriodNotPaid,
  downloadBaPayoutStatement,
  reconcileBaList,
  getBaSecurityReport,
  getBaEarningsStatement,
  downloadBaEarningsStatementPdf,
  downloadBaEarningsStatementCsv,
};
