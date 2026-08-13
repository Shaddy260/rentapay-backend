// src/controllers/baAdminPayout.controller.js
//
// BUILD SPEC PHASE 11 - Admin: Payout Review, Reconciliation &
// Cross-BA Security Report.
//
// Part A - getPayoutReview / markBaPeriodPaid / markBaPeriodNotPaid:
//   a period-scoped view of every BA's owed total (base + commission,
//   shown separately) built ONLY from ba_landlord_claims' stored
//   snapshots (payout_amount/commission_bonus_amount) - never
//   recomputed from the live payout_rules/commission_tiers rows at
//   read time, per the Money & Data Integrity Rules. "Mark as Paid" is
//   made idempotent via ba_payout_period_marks' unique (ba_id,
//   period_type, period_key) constraint (see the Phase 11 SQL
//   migration) so a double-click/retry can never double-count.
//
// Part B - reconcileBaList: defensively parses a pasted block of text
// (WhatsApp-style, one name/number per line, loose format) and
// compares it against that BA's actual claims for a given date.
//
// Part C - getBaSecurityReport: a standing, no-selection-required scan
// across ALL BAs for four fraud-signal buckets.
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
      .select('id, ba_code, full_name, phone, email, status, current_commission_percent')
      .order('full_name', { ascending: true });
    if (baErr) throw baErr;

    // REBUILT (Section E/F): commission is a recurring percentage of
    // each completed landlord subscription payment, recorded in
    // ba_commission_earnings (one row per payment) rather than a
    // one-time snapshot on the now-dropped ba_landlord_claims. paid_at
    // is what a payout period groups by - the moment the money was
    // actually earned, same intent as the old qualified_at grouping.
    const { data: earnings, error: earningsErr } = await supabase
      .from('ba_commission_earnings')
      .select('id, ba_id, landlord_id, payment_amount, percentage_applied, commission_amount, paid_at, landlords(full_name, location)')
      .gte('paid_at', range.start.toISOString())
      .lt('paid_at', range.end.toISOString())
      .order('paid_at', { ascending: true });
    if (earningsErr) throw earningsErr;

    const { data: mark, error: markErr } = await supabase
      .from('ba_payout_period_marks')
      .select('ba_id, status, marked_paid_by, marked_paid_at')
      .eq('period_type', periodType)
      .eq('period_key', periodKey);
    if (markErr) throw markErr;
    const markByBa = new Map((mark || []).map((m) => [m.ba_id, m]));

    const earningsByBa = new Map();
    for (const e of earnings || []) {
      if (!earningsByBa.has(e.ba_id)) earningsByBa.set(e.ba_id, []);
      earningsByBa.get(e.ba_id).push(e);
    }

    // Item 10 - "Payout Run" view needs, per BA: total landlords that
    // qualify, total that do NOT qualify, and their commission rate -
    // not just the period-scoped $ owed above. REBUILT (Section C):
    // qualification now lives directly on landlords.
    // ba_qualification_status - the same column the qualification job
    // and Section F's report already use, so no screen can disagree.
    // NOT period-scoped - reflects the BA's full onboarded roster.
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

    const rows = (bas || [])
      .map((ba) => {
        const baEarnings = earningsByBa.get(ba.id) || [];
        // Section E replaced the old flat "base payout" + "commission
        // bonus" split with a single recurring percentage-of-payment
        // figure - there's no separate base amount anymore. Kept as a
        // (zeroed) field so the response shape - and the existing
        // frontend - don't need a reshape; the full amount now shows
        // under commissionTotal.
        const baseTotal = 0;
        const commissionTotal = baEarnings.reduce((sum, e) => sum + Number(e.commission_amount || 0), 0);
        const periodMark = markByBa.get(ba.id) || null;
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
            // Frontend uses this to render the "Inactive"/"Suspended"
            // label - earnings below are never hidden regardless of it.
            status: ba.status,
            currentCommissionPercent: ba.current_commission_percent,
          },
          // REBUILT: "claims" here means this cycle's commission-earning
          // events, one per completed landlord payment - the field name
          // is kept for the frontend, which hasn't changed shape.
          // Per-row Paid/Not Paid no longer exists (Section E has no
          // per-row status); the whole cycle is marked at once via
          // periodMarkedStatus below.
          claims: baEarnings.map((e) => ({
            id: e.id,
            landlordName: e.landlords?.full_name || 'Unknown',
            landlordLocation: e.landlords?.location || null,
            qualificationStatus: periodMark && periodMark.status === 'paid' ? 'paid' : 'qualified',
            qualifiedAt: e.paid_at,
            payoutAmount: 0,
            commissionBonusAmount: Number(e.commission_amount || 0),
            markedPaidBy: periodMark?.marked_paid_by || null,
            markedPaidAt: periodMark?.marked_paid_at || null,
          })),
          baseTotal,
          commissionTotal,
          grandTotal: baseTotal + commissionTotal,
          periodMarkedStatus: periodMark ? periodMark.status : null,
          // Item 10 - richer per-BA totals for the admin Payout Run
          // view: landlord counts are the BA's full roster (not
          // period-scoped), commission rate is their current percent.
          totalLandlordsOnboarded,
          qualifyingLandlords,
          notQualifyingLandlords,
          commissionRatePercent: Number(ba.current_commission_percent) || 0,
        };
      })
      // Item 10 - a "Payout Run" should surface every BA who has ever
      // onboarded someone, even if nothing qualified THIS period (so
      // the not-qualifying count is visible) - only a BA with an
      // entirely empty roster and no claims this period is skipped,
      // since there's nothing at all to show for them.
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
    const { periodType, periodKey } = req.body;

    const validationError = validatePeriodParams(periodType, periodKey);
    if (validationError) return res.status(400).json({ error: validationError });

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

    // Idempotency: a double-click/retry on an already-paid period is a
    // no-op that returns the existing mark, never a second payout.
    if (targetStatus === 'paid' && existingMark && existingMark.status === 'paid') {
      return res.json({ mark: existingMark, alreadyPaid: true });
    }

    // REBUILT (Section E/F): there is no more per-landlord "claim" to
    // select - commission accrues automatically per completed
    // subscription payment (ba_commission_earnings). Marking
    // Paid/Not Paid therefore always applies to this BA's WHOLE
    // selected cycle, not a hand-picked subset.
    const { data: earnings, error: earningsErr } = await supabase
      .from('ba_commission_earnings')
      .select('commission_amount')
      .eq('ba_id', baId)
      .gte('paid_at', range.start.toISOString())
      .lt('paid_at', range.end.toISOString());
    if (earningsErr) throw earningsErr;

    const baseTotal = 0;
    const commissionTotal = (earnings || []).reduce((sum, e) => sum + Number(e.commission_amount || 0), 0);
    const nowIso = new Date().toISOString();

    const markPayload = {
      ba_id: baId,
      period_type: periodType,
      period_key: periodKey,
      status: targetStatus,
      claim_ids: [],
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
        // Unique-constraint race: another request marked this exact
        // period in the moment between our read and our insert. Treat
        // it the same as the already-paid short-circuit above rather
        // than erroring - the constraint already did its job.
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
      metadata: { periodType, periodKey, baseTotal, commissionTotal },
    });

    // Item 11 - the moment admin marks a BA as paid, send them an
    // in-app notification (existing notifications system - no email/
    // SMS) with the total amount paid for this cycle. Best-effort/
    // non-fatal - a notify() failure must never undo or fail the
    // payout mark itself, which has already been committed above.
    if (targetStatus === 'paid') {
      const grandTotal = baseTotal + commissionTotal;
      try {
        await notify(
          'brand_ambassador',
          baId,
          null,
          `You've been paid KES ${grandTotal.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} for this ${periodType === 'week' ? 'week' : 'month'}.`,
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

// Lightweight CSV "Download Statement" - Phase 17 (PDF + full
// getBaEarningsStatement) hasn't been built yet in this codebase; this
// gives the Payout Review screen's "Download Statement" button
// something real to call now, built from the exact same read-only
// snapshot fields (payout_amount/commission_bonus_amount), so nothing
// here needs to change when Phase 17 lands a fuller PDF/CSV export.
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

    // REBUILT (Section E/F): sourced from ba_commission_earnings - see
    // getPayoutReview's comment above for why ba_landlord_claims is no
    // longer read here.
    const { data: earnings, error: earningsErr } = await supabase
      .from('ba_commission_earnings')
      .select('commission_amount, percentage_applied, paid_at, landlords(full_name)')
      .eq('ba_id', baId)
      .gte('paid_at', range.start.toISOString())
      .lt('paid_at', range.end.toISOString())
      .order('paid_at', { ascending: true });
    if (earningsErr) throw earningsErr;

    const { data: periodMark } = await supabase
      .from('ba_payout_period_marks')
      .select('status, marked_paid_at')
      .eq('ba_id', baId)
      .eq('period_type', periodType)
      .eq('period_key', periodKey)
      .maybeSingle();

    const rows = earnings || [];
    const lines = [['Landlord', 'Paid At', 'Commission (KES)', 'Rate Applied', 'Status', 'Paid At (Payout)'].join(',')];
    let commissionTotal = 0;
    for (const e of rows) {
      const name = (e.landlords?.full_name || 'Unknown').replace(/"/g, '""');
      commissionTotal += Number(e.commission_amount || 0);
      lines.push(
        [
          `"${name}"`,
          e.paid_at || '',
          Number(e.commission_amount || 0).toFixed(2),
          `${e.percentage_applied}%`,
          periodMark?.status === 'paid' ? 'paid' : 'qualified',
          periodMark?.marked_paid_at || '',
        ].join(',')
      );
    }
    lines.push('');
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

// =======================================================================
// PHASE 17 - Downloadable Earnings Statement (Per BA, Per Period).
//
// Pure read/export built ONLY from the same stored snapshot fields as
// Part A above (payout_amount/commission_bonus_amount) - never
// recomputed from the live payout_rules/commission_tiers rows, per the
// Money & Data Integrity Rules. Deliberately a separate code path from
// downloadBaPayoutStatement above rather than a refactor of it: that
// one is Payout Review's own admin tool and includes 'not_paid' claims
// scoped to qualified_at falling in a week/month payout period; this
// one is the BA-facing (and admin-on-demand) earnings statement, scoped
// to 'qualified'/'paid' only, over a month OR an arbitrary custom
// range - keeping them separate means neither has to grow conditionals
// for the other's slightly different rules.
// =======================================================================

// Accepts either a calendar month ('month' + 'YYYY-MM') or a custom
// range ('custom' + from/to as 'YYYY-MM-DD', inclusive of both ends).
// Throws a plain Error with a user-facing message on bad input - every
// caller below catches it and responds 400.
function statementPeriodRange(periodType, periodKey, from, to) {
  if (periodType === 'month') {
    const range = periodRange('month', periodKey);
    return { ...range, label: periodKey, markPeriodType: 'month', markPeriodKey: periodKey };
  }
  if (periodType === 'custom') {
    if (!from || !to) throw new Error('from and to are required for a custom period.');
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error('Invalid custom date range.');
    }
    end.setUTCDate(end.getUTCDate() + 1); // "to" is inclusive of that whole day
    if (start >= end) throw new Error('The "from" date must be before the "to" date.');
    // A custom range has no matching cycle-level Paid/Not Paid mark
    // (that's a month/week concept - see ba_payout_period_marks), so
    // every row in a custom-range statement reads as 'qualified'.
    return { start, end, label: `${from}_to_${to}`, markPeriodType: null, markPeriodKey: null };
  }
  throw new Error('periodType must be "month" or "custom".');
}

// Shared builder used by the JSON endpoint and both export formats
// below, so all three always agree on exactly the same rows/totals.
async function fetchEarningsStatementData(baId, range) {
  const { data: ba, error: baErr } = await supabase
    .from('brand_ambassadors')
    .select('id, ba_code, full_name, phone, email')
    .eq('id', baId)
    .maybeSingle();
  if (baErr) throw baErr;
  if (!ba) return null;

  // REBUILT (Section E/F): sourced from ba_commission_earnings, one
  // row per completed landlord subscription payment this BA earned
  // commission on. unit_pricing_tiers / commission_tiers (the old
  // fixed-bracket tables referenced here) were dropped by the Section
  // E migration along with ba_landlord_claims - the "why was I paid
  // this" transparency line below now shows the percentage rate and
  // payment amount that were actually applied instead.
  const { data: earnings, error: earningsErr } = await supabase
    .from('ba_commission_earnings')
    .select('id, payment_amount, percentage_applied, commission_amount, paid_at, landlords(full_name, location)')
    .eq('ba_id', baId)
    .gte('paid_at', range.start.toISOString())
    .lt('paid_at', range.end.toISOString())
    .order('paid_at', { ascending: true });
  if (earningsErr) throw earningsErr;

  // A cycle-level Paid/Not Paid mark (ba_payout_period_marks) now
  // covers every earning in that whole month/week at once - there's
  // no more per-row status to read.
  let periodMark = null;
  if (range.markPeriodType && range.markPeriodKey) {
    const { data } = await supabase
      .from('ba_payout_period_marks')
      .select('status, marked_paid_at, marked_paid_by')
      .eq('ba_id', baId)
      .eq('period_type', range.markPeriodType)
      .eq('period_key', range.markPeriodKey)
      .maybeSingle();
    periodMark = data || null;
  }

  const rows = (earnings || []).map((e) => ({
    id: e.id,
    landlordName: e.landlords?.full_name || 'Unknown',
    landlordLocation: e.landlords?.location || '',
    qualifiedAt: e.paid_at,
    payoutAmount: 0,
    commissionBonusAmount: Number(e.commission_amount || 0),
    commissionTierId: null,
    status: periodMark && periodMark.status === 'paid' ? 'paid' : 'qualified',
    markedPaidAt: periodMark?.marked_paid_at || null,
    markedPaidBy: periodMark?.marked_paid_by || null,
    breakdown: {
      unitCount: null,
      unitBracket: null,
      percentage: { rate: Number(e.percentage_applied || 0), basisAmount: Number(e.payment_amount || 0) },
      commissionTier: null,
    },
  }));

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
  totals.grandTotal = totals.commissionTotal;
  totals.paidTotal = totals.paidCommissionTotal;
  totals.qualifiedNotYetPaidTotal = totals.qualifiedNotYetPaidCommissionTotal;

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
      : c.breakdown?.unitBracket
        ? `${c.breakdown.unitBracket.minUnits}-${c.breakdown.unitBracket.maxUnits ?? '+'} units @ KES ${Number(c.breakdown.unitBracket.amount).toFixed(2)}`
        : 'Flat rate';
    const commissionTier = c.breakdown?.commissionTier
      ? `${c.breakdown.commissionTier.commissionPercent}% (at ${c.breakdown.commissionTier.targetQualifiedLandlords} qualified)`
      : 'None';
    lines.push(
      [
        `"${name}"`,
        `"${location}"`,
        c.breakdown?.unitCount ?? '',
        `"${payoutBasis}"`,
        c.qualifiedAt || '',
        c.payoutAmount.toFixed(2),
        `"${commissionTier}"`,
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

// JSON - available to (a) the BA themselves for their own id (mounted
// at /brand-ambassadors/me/earnings-statement, baId taken from
// req.user.id, same scoping pattern as getBaStats/listMyClaims), and
// (b) admin for any BA (mounted at
// /brand-ambassadors/:baId/earnings-statement).
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

    // format === 'pdf'
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

// =======================================================================
// PART B - Reconciliation ("compare the list the BA sent me")
// =======================================================================

// Defensive parse: one entry per non-empty line, in whatever loose
// format admin pastes it in (e.g. copy-pasted from WhatsApp). Pulls
// out the first phone-number-like token on the line; everything else
// on the line is treated as the name.
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
        normalizedPhone = null; // kept as unmatchable rather than dropped
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

    const { data: claims, error: claimsErr } = await supabase
      .from('ba_landlord_claims')
      .select('*')
      .eq('ba_id', baId)
      .neq('match_status', 'conflict')
      .gte('created_at', dayStart.toISOString())
      .lt('created_at', dayEnd.toISOString());
    if (claimsErr) throw claimsErr;

    const claimRows = claims || [];
    const parsedEntries = parsePastedList(pastedText);

    const matchedInSystem = [];
    const claimedButMissingFromSystem = [];
    const matchedClaimIds = new Set();

    for (const entry of parsedEntries) {
      const match = entry.normalizedPhone ? claimRows.find((c) => c.submitted_phone === entry.normalizedPhone) : null;
      if (match) {
        matchedInSystem.push({ pasted: entry, claim: match });
        matchedClaimIds.add(match.id);
      } else {
        claimedButMissingFromSystem.push(entry);
      }
    }

    // Worth a manual look regardless of whether it was matched above -
    // an edited name/phone is a discrepancy in itself.
    const editedAfterSubmission = claimRows.filter(
      (c) => Array.isArray(c.edit_history) && c.edit_history.some((e) => e.editedField === 'submitted_phone' || e.editedField === 'submitted_name')
    );

    return res.json({
      ba: { id: ba.id, baCode: ba.ba_code, fullName: ba.full_name },
      date,
      matchedInSystem,
      claimedButMissingFromSystem,
      editedAfterSubmission,
      counts: {
        matched: matchedInSystem.length,
        missing: claimedButMissingFromSystem.length,
        edited: editedAfterSubmission.length,
        totalPasted: parsedEntries.length,
        totalClaimsThatDay: claimRows.length,
      },
    });
  } catch (err) {
    logger.error('[baAdminPayout] reconcileBaList error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to reconcile the pasted list.' });
  }
}

// =======================================================================
// PART C - Cross-BA security report (standing, no BA selection)
//
// REBUILT (Section A of the 2026-08-remove-manual-ba-claims migration):
// the manual claim-submission flow this report used to police
// (ba_landlord_claims - a BA typing in a landlord's name/phone by hand,
// which could be submitted by multiple BAs, matched loosely, or
// rejected as a 'conflict') no longer exists. Attribution is now fully
// automatic: a landlord is linked to a BA only via the referral
// link/code they sign up through (landlords.ba_id), with no manual
// submission step at all.
//
// That retires two of the original four signals outright - there is no
// longer a "submission" to duplicate or a "match" that can happen
// without a referral, because there is no separate submission/match
// step anymore. Rather than silently return permanently-empty arrays
// forever (which reads as "nothing to see" instead of "this check no
// longer applies"), the response marks them `retired: true` with an
// explanation, and the frontend renders that state explicitly.
//
// The other two signals still map onto the new model and are rebuilt
// below against `landlords` directly instead of `ba_landlord_claims`:
//   - rapidFireOnboarding (was rapidFireSubmissions): unusually many
//     landlords onboarded by one BA in a short window - still a
//     reasonable proxy for signups logged without an actual field
//     visit, just measured off landlords.created_at instead of a
//     claim's created_at.
//   - disputedAttributions: unchanged in spirit, now joined directly
//     off landlords.ba_id instead of via a claim's matched_landlord_id.
// =======================================================================

const SECURITY_REPORT_WINDOW_DAYS = parseInt(process.env.BA_SECURITY_REPORT_WINDOW_DAYS || '30', 10);
const RAPID_FIRE_WINDOW_MINUTES = parseInt(process.env.BA_RAPID_FIRE_WINDOW_MINUTES || '60', 10);
const RAPID_FIRE_THRESHOLD = parseInt(process.env.BA_RAPID_FIRE_THRESHOLD || '5', 10);

// Finds the single largest rolling-window cluster of landlords (>=
// threshold within windowMs of each other) for one BA's onboarded
// landlords, already sorted ascending by created_at. Returns null if
// none found. Reports only the best cluster per BA rather than every
// overlapping sub-window, so the report stays one row per flagged BA.
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

    // --- Signal: rapidFireOnboarding (was rapidFireSubmissions) --------
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

    // --- Signal: disputedAttributions -----------------------------------
    // Internal-review-only, per Phase 14 - never shown to the landlord.
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
      // Retired alongside the manual-claim-submission flow - see the
      // comment above PART C. Kept in the response (rather than
      // dropped) so older frontend builds don't crash on a missing
      // key, and so the reason is visible instead of just "empty".
      duplicatePhoneAttempts: {
        retired: true,
        reason: "Retired: landlords no longer go through a manual claim-submission step a phone number could be duplicated across, so this check no longer applies.",
      },
      notReferredButMatched: {
        retired: true,
        reason: 'Retired: attribution is now always via the referral link/code at signup - there is no more post-hoc "matched without a referral" case to flag.',
      },
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
  // Phase 17 - Downloadable Earnings Statement
  getBaEarningsStatement,
  downloadBaEarningsStatementPdf,
  downloadBaEarningsStatementCsv,
};
