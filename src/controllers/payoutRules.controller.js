// src/controllers/payoutRules.controller.js
//
// Consolidated Change Instructions - Section E (percentage commission,
// HARD CUTOVER replacing the old fixed-price payout_rules /
// commission_tiers / unit_pricing_tiers model entirely - see
// 2026-08-section-e-recurring-percentage-commission.sql).
//
// payout_rules is now a pure, append-only PERCENTAGE-RATE HISTORY per
// scope (global / ba_override): setting a new rate always INSERTS a
// new row with its own effective_from rather than overwriting the
// current one. The rate applied to any given payment = whichever row
// has the latest effective_from at or before that payment's paid_at
// (see baCommission.service.js's resolveApplicableRate - the same
// lookup, reused here for the read-side "what's the current/upcoming
// rate" views).
//
// Every rate change (global or BA-specific) triggers an immediate
// in-app + push notification to affected BA(s) - see
// baCommission.service.js's notifyRateChange.
//
// Commission_tiers and unit_pricing_tiers endpoints that used to live
// in this file are GONE - those tables no longer exist (hard cutover).
// Qualification-dry-run stays here unchanged (Section C, untouched by
// this section).

const supabase = require('../config/supabase');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const { runBaQualificationCheck } = require('../jobs/baQualification.job');
const { notifyRateChange } = require('../services/baCommission.service');
const { brandCsv, brandedFilename } = require('../services/csvBranding.service');
const logger = require('../utils/logger');

const ADMIN_ACTOR_ID = 'super-admin';

// ---------------------------------------------------------------------
// Percentage commission rate - global default + optional per-BA
// override, each an append-only history.
// ---------------------------------------------------------------------

async function currentAndUpcoming(scope, baId) {
  let query = supabase.from('payout_rules').select('*').eq('scope', scope).order('effective_from', { ascending: false });
  query = baId ? query.eq('ba_id', baId) : query.is('ba_id', null);
  const { data, error } = await query;
  if (error) throw error;

  const rows = data || [];
  const now = new Date();
  const current = rows.find((r) => new Date(r.effective_from) <= now) || null;
  const upcoming = rows.filter((r) => new Date(r.effective_from) > now).sort((a, b) => new Date(a.effective_from) - new Date(b.effective_from));
  const history = rows.filter((r) => new Date(r.effective_from) <= now);

  return { current, upcoming, history };
}

async function getPayoutRules(req, res) {
  try {
    const { baId } = req.query;

    const global = await currentAndUpcoming('global', null);
    let override = null;
    if (baId) {
      override = await currentAndUpcoming('ba_override', baId);
    }

    return res.json({ global, override });
  } catch (err) {
    logger.error('[payoutRules] getPayoutRules error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load payout rules.' });
  }
}

function validatePercentagePayload(body) {
  const percentage = Number(body.percentage);
  if (Number.isNaN(percentage) || percentage < 0 || percentage > 100) {
    return { error: 'A valid commission percentage between 0 and 100 is required.' };
  }

  // "Immediately, or from a specific future date (date picker, default
  // = today)" - a missing/blank effectiveFrom means "now".
  let effectiveFrom = new Date();
  if (body.effectiveFrom) {
    const parsed = new Date(body.effectiveFrom);
    if (Number.isNaN(parsed.getTime())) {
      return { error: 'effectiveFrom must be a valid date.' };
    }
    effectiveFrom = parsed;
  }

  return { percentage, effectiveFrom };
}

async function updateGlobalPayoutRule(req, res) {
  try {
    const parsed = validatePercentagePayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { percentage, effectiveFrom } = parsed;

    const { current: existingCurrent } = await currentAndUpcoming('global', null);

    const { data: saved, error: insertErr } = await supabase
      .from('payout_rules')
      .insert({
        scope: 'global',
        ba_id: null,
        percentage,
        effective_from: effectiveFrom.toISOString(),
        set_by_admin_id: ADMIN_ACTOR_ID,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: 'payout_rule_global_rate_set',
      targetType: 'payout_rules',
      targetId: saved.id,
      ipAddress: req.ip,
      metadata: { before: existingCurrent, after: saved },
    });

    // Every rate change triggers an immediate notification, in-app +
    // push, to every affected BA - fire-and-forget-with-logging, never
    // blocks the admin's save.
    notifyRateChange({
      scope: 'global',
      oldPercentage: existingCurrent ? Number(existingCurrent.percentage) : null,
      newPercentage: percentage,
      effectiveFrom,
    }).catch((err) => {
      logger.error('[payoutRules] global rate-change notification failed:', err.message);
      captureException(err);
    });

    return res.json({ rule: saved });
  } catch (err) {
    logger.error('[payoutRules] updateGlobalPayoutRule error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update the global commission rate.' });
  }
}

async function setBaPayoutOverride(req, res) {
  try {
    const { baId } = req.params;
    const { clear } = req.body;

    const { current: existingCurrent, history } = await currentAndUpcoming('ba_override', baId);

    if (clear) {
      // No partial "unlink one rate" concept - clearing an override
      // means this BA reverts fully to the global rate going forward;
      // the override's own history rows are removed entirely so a
      // stale row can never accidentally resurface in a future
      // resolveApplicableRate lookup.
      if (history.length > 0 || existingCurrent) {
        const { error } = await supabase.from('payout_rules').delete().eq('scope', 'ba_override').eq('ba_id', baId);
        if (error) throw error;
      }
      logActivity({
        actorType: 'admin',
        actorId: ADMIN_ACTOR_ID,
        action: 'payout_rule_ba_override_cleared',
        targetType: 'brand_ambassador',
        targetId: baId,
        ipAddress: req.ip,
        metadata: { before: existingCurrent, after: null },
      });

      const { current: globalCurrent } = await currentAndUpcoming('global', null);
      notifyRateChange({
        scope: 'ba_override',
        baId,
        oldPercentage: existingCurrent ? Number(existingCurrent.percentage) : null,
        newPercentage: globalCurrent ? Number(globalCurrent.percentage) : 0,
        effectiveFrom: new Date(),
      }).catch((err) => {
        logger.error('[payoutRules] override-clear notification failed:', err.message);
        captureException(err);
      });

      return res.json({ override: null });
    }

    const parsed = validatePercentagePayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { percentage, effectiveFrom } = parsed;

    const { data: saved, error: insertErr } = await supabase
      .from('payout_rules')
      .insert({
        scope: 'ba_override',
        ba_id: baId,
        percentage,
        effective_from: effectiveFrom.toISOString(),
        set_by_admin_id: ADMIN_ACTOR_ID,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: 'payout_rule_ba_override_rate_set',
      targetType: 'brand_ambassador',
      targetId: baId,
      ipAddress: req.ip,
      metadata: { before: existingCurrent, after: saved },
    });

    notifyRateChange({
      scope: 'ba_override',
      baId,
      oldPercentage: existingCurrent ? Number(existingCurrent.percentage) : null,
      newPercentage: percentage,
      effectiveFrom,
    }).catch((err) => {
      logger.error('[payoutRules] override rate-change notification failed:', err.message);
      captureException(err);
    });

    return res.json({ override: saved });
  } catch (err) {
    logger.error('[payoutRules] setBaPayoutOverride error:', err.message);
    captureException(err);
    return res.status(500).json({ error: "Failed to update this BA's commission rate override." });
  }
}

// Full history for one scope, newest first - powers the "rate applied
// per landlord's payment (resolved... may differ across landlords
// within the same BA if a rate changed mid-cycle)" transparency called
// for by Section F/G, and a simple audit trail in the admin UI itself.
async function getPayoutRuleHistory(req, res) {
  try {
    const { baId } = req.query;
    const scope = baId ? 'ba_override' : 'global';
    let query = supabase.from('payout_rules').select('*').eq('scope', scope).order('effective_from', { ascending: false });
    query = baId ? query.eq('ba_id', baId) : query.is('ba_id', null);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ history: data || [] });
  } catch (err) {
    logger.error('[payoutRules] getPayoutRuleHistory error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the rate history.' });
  }
}

// ---------------------------------------------------------------------
// PHASE 19 - Qualification Job Dry-Run Mode (Section C - unaffected by
// Section E, kept exactly as before).
// ---------------------------------------------------------------------

async function runQualificationDryRun(req, res) {
  try {
    const result = await runBaQualificationCheck({ forceDryRun: true });
    return res.json({
      checked: result.checked,
      qualified: result.qualified,
      skippedInactiveBa: result.skippedInactiveBa,
      errors: result.errors,
      report: result.report || [],
    });
  } catch (err) {
    logger.error('[payoutRules] runQualificationDryRun error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to run the qualification dry-run.' });
  }
}

// FIX (direct request: landlords stuck showing "Pending" in a BA's
// dashboard with "0 qualifying" - the nightly cron only runs at
// 00:05, so anyone who paid earlier today has to wait until then).
// Lets admin trigger the SAME check the nightly cron runs, for real
// (not a dry-run) - useful right after deploying this fix, to
// immediately qualify + backfill commission for landlords whose first
// payment completed before the fix existed, without waiting for the
// next scheduled run.
async function runQualificationNow(req, res) {
  try {
    const result = await runBaQualificationCheck();
    return res.json({
      checked: result.checked,
      qualified: result.qualified,
      skippedInactiveBa: result.skippedInactiveBa,
      errors: result.errors,
    });
  } catch (err) {
    logger.error('[payoutRules] runQualificationNow error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to run the qualification check.' });
  }
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

async function downloadQualificationDryRunCsv(req, res) {
  try {
    const result = await runBaQualificationCheck({ forceDryRun: true });
    const rows = result.report || [];

    const lines = [
      ['Landlord ID', 'BA Code', 'BA Name', 'Landlord Name'].join(','),
    ];
    for (const r of rows) {
      lines.push(
        [
          csvEscape(r.landlordId),
          csvEscape(r.baCode),
          csvEscape(r.baName),
          csvEscape(r.landlordName),
        ].join(',')
      );
    }
    lines.push('');
    lines.push(`Landlords checked,${result.checked}`);
    lines.push(`Would qualify,${result.qualified}`);

    const filename = brandedFilename('ba-qualification-dry-run', new Date().toISOString().slice(0, 10), 'csv');
    const csv = brandCsv({
      title: 'BA Qualification Dry Run',
      body: lines,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) {
    logger.error('[payoutRules] downloadQualificationDryRunCsv error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate the dry-run report.' });
  }
}

module.exports = {
  getPayoutRules,
  updateGlobalPayoutRule,
  setBaPayoutOverride,
  getPayoutRuleHistory,
  runQualificationDryRun,
  runQualificationNow,
  downloadQualificationDryRunCsv,
};
