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

    // qualified_at is the moment a claim BECAME owed money - that's
    // what a payout period groups by, not created_at (when it was
    // first logged, possibly weeks earlier) or marked_paid_at (when
    // admin got around to paying it).
    const { data: claims, error: claimsErr } = await supabase
      .from('ba_landlord_claims')
      .select(
        'id, ba_id, submitted_name, submitted_location, qualification_status, qualified_at, payout_amount, commission_bonus_amount, commission_tier_id, marked_paid_by, marked_paid_at, matched_landlord_id, landlords(full_name, location)'
      )
      .in('qualification_status', ['qualified', 'paid', 'not_paid'])
      .gte('qualified_at', range.start.toISOString())
      .lt('qualified_at', range.end.toISOString())
      .order('qualified_at', { ascending: true });
    if (claimsErr) throw claimsErr;

    const { data: mark, error: markErr } = await supabase
      .from('ba_payout_period_marks')
      .select('ba_id, status, marked_paid_by, marked_paid_at')
      .eq('period_type', periodType)
      .eq('period_key', periodKey);
    if (markErr) throw markErr;
    const markByBa = new Map((mark || []).map((m) => [m.ba_id, m]));

    const claimsByBa = new Map();
    for (const c of claims || []) {
      if (!claimsByBa.has(c.ba_id)) claimsByBa.set(c.ba_id, []);
      claimsByBa.get(c.ba_id).push(c);
    }

    const rows = (bas || [])
      .map((ba) => {
        const baClaims = claimsByBa.get(ba.id) || [];
        const baseTotal = baClaims.reduce((sum, c) => sum + Number(c.payout_amount || 0), 0);
        const commissionTotal = baClaims.reduce((sum, c) => sum + Number(c.commission_bonus_amount || 0), 0);
        const periodMark = markByBa.get(ba.id) || null;

        return {
          ba: {
            id: ba.id,
            baCode: ba.ba_code,
            fullName: ba.full_name,
            phone: ba.phone,
            email: ba.email,
            // Frontend uses this to render the "Inactive"/"Suspended"
            // label - claims below are never hidden regardless of it.
            status: ba.status,
            currentCommissionPercent: ba.current_commission_percent,
          },
          claims: baClaims.map((c) => ({
            id: c.id,
            landlordName: c.landlords?.full_name || c.submitted_name,
            landlordLocation: c.landlords?.location || c.submitted_location || null,
            qualificationStatus: c.qualification_status,
            qualifiedAt: c.qualified_at,
            payoutAmount: Number(c.payout_amount || 0),
            commissionBonusAmount: Number(c.commission_bonus_amount || 0),
            markedPaidBy: c.marked_paid_by,
            markedPaidAt: c.marked_paid_at,
          })),
          baseTotal,
          commissionTotal,
          grandTotal: baseTotal + commissionTotal,
          periodMarkedStatus: periodMark ? periodMark.status : null,
        };
      })
      // Only surface BAs with actual activity this period - an empty
      // row for every never-active BA would swamp the screen.
      .filter((row) => row.claims.length > 0);

    return res.json({ periodType, periodKey, bas: rows });
  } catch (err) {
    logger.error('[baAdminPayout] getPayoutReview error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the payout review.' });
  }
}

async function markBaPeriod(req, res, targetStatus) {
  try {
    const { baId } = req.params;
    const { periodType, periodKey, claimIds } = req.body;

    const validationError = validatePeriodParams(periodType, periodKey);
    if (validationError) return res.status(400).json({ error: validationError });
    if (!Array.isArray(claimIds) || claimIds.length === 0) {
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

    // Idempotency: a double-click/retry on an already-paid period is a
    // no-op that returns the existing mark, never a second payout.
    if (targetStatus === 'paid' && existingMark && existingMark.status === 'paid') {
      return res.json({ mark: existingMark, alreadyPaid: true });
    }

    const { data: claims, error: claimsErr } = await supabase
      .from('ba_landlord_claims')
      .select('id, ba_id, qualification_status, qualified_at, payout_amount, commission_bonus_amount')
      .in('id', claimIds);
    if (claimsErr) throw claimsErr;

    if ((claims || []).length !== claimIds.length) {
      return res.status(400).json({ error: 'One or more claim ids were not found.' });
    }
    for (const c of claims) {
      if (c.ba_id !== baId) return res.status(400).json({ error: `Claim ${c.id} does not belong to this Brand Ambassador.` });
      if (!['qualified', 'paid', 'not_paid'].includes(c.qualification_status)) {
        return res.status(400).json({ error: `Claim ${c.id} is not qualified for payout.` });
      }
      if (!c.qualified_at || new Date(c.qualified_at) < range.start || new Date(c.qualified_at) >= range.end) {
        return res.status(400).json({ error: `Claim ${c.id} does not fall in the selected period.` });
      }
    }

    const baseTotal = claims.reduce((sum, c) => sum + Number(c.payout_amount || 0), 0);
    const commissionTotal = claims.reduce((sum, c) => sum + Number(c.commission_bonus_amount || 0), 0);
    const nowIso = new Date().toISOString();

    const markPayload = {
      ba_id: baId,
      period_type: periodType,
      period_key: periodKey,
      status: targetStatus,
      claim_ids: claimIds,
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

    const claimUpdatePayload =
      targetStatus === 'paid'
        ? { qualification_status: 'paid', marked_paid_by: ADMIN_ACTOR_ID, marked_paid_at: nowIso }
        : { qualification_status: 'not_paid', marked_paid_by: null, marked_paid_at: null };

    const { error: updateErr } = await supabase.from('ba_landlord_claims').update(claimUpdatePayload).in('id', claimIds);
    if (updateErr) throw updateErr;

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: targetStatus === 'paid' ? 'ba_payout_period_marked_paid' : 'ba_payout_period_marked_not_paid',
      targetType: 'brand_ambassador',
      targetId: baId,
      ipAddress: req.ip,
      metadata: { periodType, periodKey, claimIds, baseTotal, commissionTotal },
    });

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

    const { data: claims, error: claimsErr } = await supabase
      .from('ba_landlord_claims')
      .select('id, submitted_name, qualification_status, qualified_at, payout_amount, commission_bonus_amount, marked_paid_at, landlords(full_name)')
      .eq('ba_id', baId)
      .in('qualification_status', ['qualified', 'paid', 'not_paid'])
      .gte('qualified_at', range.start.toISOString())
      .lt('qualified_at', range.end.toISOString())
      .order('qualified_at', { ascending: true });
    if (claimsErr) throw claimsErr;

    const rows = claims || [];
    const lines = [['Landlord', 'Qualified At', 'Base Payout (KES)', 'Commission Bonus (KES)', 'Status', 'Paid At'].join(',')];
    let baseTotal = 0;
    let commissionTotal = 0;
    for (const c of rows) {
      const name = (c.landlords?.full_name || c.submitted_name || '').replace(/"/g, '""');
      baseTotal += Number(c.payout_amount || 0);
      commissionTotal += Number(c.commission_bonus_amount || 0);
      lines.push(
        [`"${name}"`, c.qualified_at || '', Number(c.payout_amount || 0).toFixed(2), Number(c.commission_bonus_amount || 0).toFixed(2), c.qualification_status, c.marked_paid_at || ''].join(',')
      );
    }
    lines.push('');
    lines.push(`Base Total,,${baseTotal.toFixed(2)}`);
    lines.push(`Commission Total,,,${commissionTotal.toFixed(2)}`);
    lines.push(`Grand Total,,,,${(baseTotal + commissionTotal).toFixed(2)}`);

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
    return { ...range, label: periodKey };
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
    return { start, end, label: `${from}_to_${to}` };
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

  const { data: claims, error: claimsErr } = await supabase
    .from('ba_landlord_claims')
    .select(
      'id, submitted_name, submitted_location, qualification_status, qualified_at, payout_amount, commission_bonus_amount, commission_tier_id, marked_paid_at, marked_paid_by, landlords(full_name, location)'
    )
    .eq('ba_id', baId)
    .in('qualification_status', ['qualified', 'paid'])
    .gte('qualified_at', range.start.toISOString())
    .lt('qualified_at', range.end.toISOString())
    .order('qualified_at', { ascending: true });
  if (claimsErr) throw claimsErr;

  const rows = (claims || []).map((c) => ({
    id: c.id,
    landlordName: c.landlords?.full_name || c.submitted_name || 'Unknown',
    landlordLocation: c.landlords?.location || c.submitted_location || '',
    qualifiedAt: c.qualified_at,
    payoutAmount: Number(c.payout_amount || 0),
    commissionBonusAmount: Number(c.commission_bonus_amount || 0),
    commissionTierId: c.commission_tier_id || null,
    status: c.qualification_status, // 'qualified' | 'paid'
    markedPaidAt: c.marked_paid_at,
    markedPaidBy: c.marked_paid_by,
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
    totals.baseTotal += r.payoutAmount;
    totals.commissionTotal += r.commissionBonusAmount;
    if (r.status === 'paid') {
      totals.paidBaseTotal += r.payoutAmount;
      totals.paidCommissionTotal += r.commissionBonusAmount;
    } else {
      totals.qualifiedNotYetPaidBaseTotal += r.payoutAmount;
      totals.qualifiedNotYetPaidCommissionTotal += r.commissionBonusAmount;
    }
  }
  totals.grandTotal = totals.baseTotal + totals.commissionTotal;
  totals.paidTotal = totals.paidBaseTotal + totals.paidCommissionTotal;
  totals.qualifiedNotYetPaidTotal = totals.qualifiedNotYetPaidBaseTotal + totals.qualifiedNotYetPaidCommissionTotal;

  return { ba, claims: rows, totals };
}

function buildEarningsStatementCsv(ba, claims, totals, periodLabel) {
  const lines = [['Landlord', 'Location', 'Qualified At', 'Base Payout (KES)', 'Commission Bonus (KES)', 'Status', 'Paid At'].join(',')];
  for (const c of claims) {
    const name = String(c.landlordName || '').replace(/"/g, '""');
    const location = String(c.landlordLocation || '').replace(/"/g, '""');
    lines.push(
      [`"${name}"`, `"${location}"`, c.qualifiedAt || '', c.payoutAmount.toFixed(2), c.commissionBonusAmount.toFixed(2), c.status, c.markedPaidAt || ''].join(',')
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
// =======================================================================

const SECURITY_REPORT_WINDOW_DAYS = parseInt(process.env.BA_SECURITY_REPORT_WINDOW_DAYS || '30', 10);
const RAPID_FIRE_WINDOW_MINUTES = parseInt(process.env.BA_RAPID_FIRE_WINDOW_MINUTES || '60', 10);
const RAPID_FIRE_THRESHOLD = parseInt(process.env.BA_RAPID_FIRE_THRESHOLD || '5', 10);

// Finds the single largest rolling-window cluster of claims (>=
// threshold claims within windowMs of each other) for one BA's claims,
// already sorted ascending by created_at. Returns null if none found.
// Reports only the best cluster per BA rather than every overlapping
// sub-window, so the report stays one row per flagged BA.
function findRapidFireCluster(claimsAsc, windowMs, threshold) {
  let windowStart = 0;
  let best = null;
  for (let i = 0; i < claimsAsc.length; i++) {
    while (new Date(claimsAsc[i].created_at) - new Date(claimsAsc[windowStart].created_at) > windowMs) windowStart++;
    const size = i - windowStart + 1;
    if (size >= threshold && (!best || size > best.count)) {
      best = {
        count: size,
        claimIds: claimsAsc.slice(windowStart, i + 1).map((c) => c.id),
        from: claimsAsc[windowStart].created_at,
        to: claimsAsc[i].created_at,
      };
    }
  }
  return best;
}

async function getBaSecurityReport(req, res) {
  try {
    const windowStart = new Date();
    windowStart.setUTCDate(windowStart.getUTCDate() - SECURITY_REPORT_WINDOW_DAYS);

    const { data: claims, error: claimsErr } = await supabase
      .from('ba_landlord_claims')
      .select(
        'id, ba_id, submitted_name, submitted_phone, match_status, qualification_status, matched_landlord_id, referred_at_signup, created_at, brand_ambassadors(full_name, ba_code, status)'
      )
      .gte('created_at', windowStart.toISOString())
      .order('created_at', { ascending: true });
    if (claimsErr) throw claimsErr;

    const rows = claims || [];

    // --- Signal 1: duplicatePhoneAttempts -----------------------------
    // Any phone number more than one BA has ever tried to submit a
    // claim for - includes 'conflict' rows (rejected attempts), not
    // just the winning 'matched' claim.
    const byPhone = new Map();
    for (const c of rows) {
      if (!byPhone.has(c.submitted_phone)) byPhone.set(c.submitted_phone, []);
      byPhone.get(c.submitted_phone).push(c);
    }
    const duplicatePhoneAttempts = [];
    for (const [phone, list] of byPhone) {
      const distinctBaIds = [...new Set(list.map((c) => c.ba_id))];
      if (distinctBaIds.length > 1) {
        duplicatePhoneAttempts.push({
          phone,
          bas: distinctBaIds.map((id) => {
            const sample = list.find((c) => c.ba_id === id);
            return {
              baId: id,
              baName: sample.brand_ambassadors?.full_name || null,
              baCode: sample.brand_ambassadors?.ba_code || null,
              claimIds: list.filter((c) => c.ba_id === id).map((c) => c.id),
            };
          }),
        });
      }
    }

    // --- Signal 2: notReferredButMatched -------------------------------
    const notReferredButMatched = rows
      .filter((c) => c.match_status === 'matched' && !c.referred_at_signup)
      .map((c) => ({
        claimId: c.id,
        baId: c.ba_id,
        baName: c.brand_ambassadors?.full_name || null,
        submittedName: c.submitted_name,
        submittedPhone: c.submitted_phone,
        createdAt: c.created_at,
      }));

    // --- Signal 3: rapidFireSubmissions --------------------------------
    const byBa = new Map();
    for (const c of rows) {
      if (!byBa.has(c.ba_id)) byBa.set(c.ba_id, []);
      byBa.get(c.ba_id).push(c);
    }
    const windowMs = RAPID_FIRE_WINDOW_MINUTES * 60 * 1000;
    const rapidFireSubmissions = [];
    for (const [baId, list] of byBa) {
      const cluster = findRapidFireCluster(list, windowMs, RAPID_FIRE_THRESHOLD);
      if (cluster) {
        rapidFireSubmissions.push({
          baId,
          baName: list[0].brand_ambassadors?.full_name || null,
          claimIds: cluster.claimIds,
          count: cluster.count,
          windowMinutes: RAPID_FIRE_WINDOW_MINUTES,
          from: cluster.from,
          to: cluster.to,
        });
      }
    }

    // --- Signal 4: disputedAttributions --------------------------------
    // Internal-review-only, per Phase 14 - never shown to the landlord.
    const candidateLandlordIds = [...new Set(rows.filter((c) => c.matched_landlord_id).map((c) => c.matched_landlord_id))];
    let disputedAttributions = [];
    if (candidateLandlordIds.length > 0) {
      const { data: disputedLandlords, error: dlErr } = await supabase
        .from('landlords')
        .select('id, full_name, ba_attribution_disputed_at')
        .in('id', candidateLandlordIds)
        .eq('ba_attribution_disputed', true);
      if (dlErr) throw dlErr;

      const disputedById = new Map((disputedLandlords || []).map((l) => [l.id, l]));
      disputedAttributions = rows
        .filter((c) => disputedById.has(c.matched_landlord_id))
        .map((c) => {
          const landlord = disputedById.get(c.matched_landlord_id);
          return {
            claimId: c.id,
            baId: c.ba_id,
            baName: c.brand_ambassadors?.full_name || null,
            landlordId: landlord.id,
            landlordName: landlord.full_name,
            disputedAt: landlord.ba_attribution_disputed_at,
          };
        });
    }

    return res.json({
      windowDays: SECURITY_REPORT_WINDOW_DAYS,
      duplicatePhoneAttempts,
      notReferredButMatched,
      rapidFireSubmissions,
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
  // Phase 17 - Downloadable Earnings Statement
  getBaEarningsStatement,
  downloadBaEarningsStatementPdf,
  downloadBaEarningsStatementCsv,
};
