// src/controllers/payoutRules.controller.js
//
// BUILD SPEC PHASE 10 - Payout Rules Engine, Qualification & Commission
// Tiers: admin-only CRUD for the single global payout_rules row, an
// optional per-BA override row, the global commission_tiers ladder,
// and an optional per-BA override ladder. Every change is logged via
// activityLog.service.js with who/when/before/after, same convention
// admin.controller.js already uses for subscription edits.
//
// Read side (getPayoutRules/getCommissionTiers) intentionally returns
// BOTH the global row/ladder and, if present, a specific BA's override,
// so the admin UI can show "using global" vs "custom override" without
// a second round trip.

const supabase = require('../config/supabase');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const { runBaQualificationCheck } = require('../jobs/baQualification.job');
const logger = require('../utils/logger');

const ADMIN_ACTOR_ID = 'super-admin';

// ---------------------------------------------------------------------
// Payout rules (amount / required_consecutive_months / min_units)
// ---------------------------------------------------------------------

async function getPayoutRules(req, res) {
  try {
    const { baId } = req.query;

    const { data: global, error: globalErr } = await supabase
      .from('payout_rules')
      .select('*')
      .eq('scope', 'global')
      .maybeSingle();
    if (globalErr) throw globalErr;

    let override = null;
    if (baId) {
      const { data, error } = await supabase
        .from('payout_rules')
        .select('*')
        .eq('scope', 'ba_override')
        .eq('ba_id', baId)
        .maybeSingle();
      if (error) throw error;
      override = data || null;
    }

    return res.json({ global: global || null, override });
  } catch (err) {
    logger.error('[payoutRules] getPayoutRules error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load payout rules.' });
  }
}

async function updateGlobalPayoutRule(req, res) {
  try {
    const { amount, requiredConsecutiveMonths, minUnits } = req.body;
    if (amount == null || Number.isNaN(Number(amount)) || Number(amount) < 0) {
      return res.status(400).json({ error: 'A valid, non-negative amount is required.' });
    }
    const months = requiredConsecutiveMonths != null ? parseInt(requiredConsecutiveMonths, 10) : 2;
    const minUnitsVal = minUnits != null ? parseInt(minUnits, 10) : 1;
    if (!Number.isInteger(months) || months < 1) {
      return res.status(400).json({ error: 'requiredConsecutiveMonths must be a positive integer.' });
    }
    if (!Number.isInteger(minUnitsVal) || minUnitsVal < 1) {
      return res.status(400).json({ error: 'minUnits must be a positive integer.' });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('payout_rules')
      .select('*')
      .eq('scope', 'global')
      .maybeSingle();
    if (fetchErr) throw fetchErr;

    const payload = {
      scope: 'global',
      ba_id: null,
      amount: Number(amount),
      required_consecutive_months: months,
      min_units: minUnitsVal,
      updated_at: new Date().toISOString(),
    };

    let saved;
    if (existing) {
      const { data, error } = await supabase.from('payout_rules').update(payload).eq('id', existing.id).select().single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase.from('payout_rules').insert(payload).select().single();
      if (error) throw error;
      saved = data;
    }

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: 'payout_rule_global_updated',
      targetType: 'payout_rules',
      targetId: saved.id,
      ipAddress: req.ip,
      metadata: { before: existing || null, after: saved },
    });

    return res.json({ rule: saved });
  } catch (err) {
    logger.error('[payoutRules] updateGlobalPayoutRule error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update the global payout rule.' });
  }
}

async function setBaPayoutOverride(req, res) {
  try {
    const { baId } = req.params;
    const { amount, requiredConsecutiveMonths, minUnits, clear } = req.body;

    const { data: existing, error: fetchErr } = await supabase
      .from('payout_rules')
      .select('*')
      .eq('scope', 'ba_override')
      .eq('ba_id', baId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;

    if (clear) {
      if (existing) {
        const { error } = await supabase.from('payout_rules').delete().eq('id', existing.id);
        if (error) throw error;
      }
      logActivity({
        actorType: 'admin',
        actorId: ADMIN_ACTOR_ID,
        action: 'payout_rule_ba_override_cleared',
        targetType: 'brand_ambassador',
        targetId: baId,
        ipAddress: req.ip,
        metadata: { before: existing || null, after: null },
      });
      return res.json({ override: null });
    }

    if (amount == null || Number.isNaN(Number(amount)) || Number(amount) < 0) {
      return res.status(400).json({ error: 'A valid, non-negative amount is required.' });
    }
    const months = requiredConsecutiveMonths != null ? parseInt(requiredConsecutiveMonths, 10) : 2;
    const minUnitsVal = minUnits != null ? parseInt(minUnits, 10) : 1;

    const payload = {
      scope: 'ba_override',
      ba_id: baId,
      amount: Number(amount),
      required_consecutive_months: months,
      min_units: minUnitsVal,
      updated_at: new Date().toISOString(),
    };

    let saved;
    if (existing) {
      const { data, error } = await supabase.from('payout_rules').update(payload).eq('id', existing.id).select().single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase.from('payout_rules').insert(payload).select().single();
      if (error) throw error;
      saved = data;
    }

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: 'payout_rule_ba_override_set',
      targetType: 'brand_ambassador',
      targetId: baId,
      ipAddress: req.ip,
      metadata: { before: existing || null, after: saved },
    });

    return res.json({ override: saved });
  } catch (err) {
    logger.error('[payoutRules] setBaPayoutOverride error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update this BA\'s payout override.' });
  }
}

// ---------------------------------------------------------------------
// Commission tiers ladder
// ---------------------------------------------------------------------

function validateLadder(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return 'At least one tier is required.';
  }
  const seen = new Set();
  for (const t of tiers) {
    const target = parseInt(t.targetQualifiedLandlords, 10);
    const pct = Number(t.commissionPercent);
    if (!Number.isInteger(target) || target < 1) return 'Each tier needs a positive whole-number target.';
    if (Number.isNaN(pct) || pct < 0 || pct > 100) return 'Each tier needs a commission percent between 0 and 100.';
    if (seen.has(target)) return `Duplicate target threshold: ${target}.`;
    seen.add(target);
  }
  return null;
}

async function getCommissionTiers(req, res) {
  try {
    const { baId } = req.query;

    const { data: global, error: globalErr } = await supabase
      .from('commission_tiers')
      .select('*')
      .eq('scope', 'global')
      .order('target_qualified_landlords', { ascending: true });
    if (globalErr) throw globalErr;

    let override = null;
    if (baId) {
      const { data, error } = await supabase
        .from('commission_tiers')
        .select('*')
        .eq('scope', 'ba_override')
        .eq('ba_id', baId)
        .order('target_qualified_landlords', { ascending: true });
      if (error) throw error;
      override = data && data.length > 0 ? data : null;
    }

    return res.json({ global: global || [], override });
  } catch (err) {
    logger.error('[payoutRules] getCommissionTiers error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load commission tiers.' });
  }
}

async function updateCommissionTiers(req, res) {
  try {
    const { tiers } = req.body;
    const validationError = validateLadder(tiers);
    if (validationError) return res.status(400).json({ error: validationError });

    const { data: existing, error: fetchErr } = await supabase
      .from('commission_tiers')
      .select('*')
      .eq('scope', 'global');
    if (fetchErr) throw fetchErr;

    // Replace the whole global ladder atomically-ish: delete then
    // insert. Simpler and safer than trying to diff/upsert individual
    // rows against arbitrary target changes, and this table has no
    // other rows referencing it by id that would break (claims store
    // commission_tier_id but via ON DELETE SET NULL, and only ever
    // point at a tier AFTER it was crossed - a currently-unconfigured
    // ladder being replaced has no qualified claims pointing at it yet
    // in the normal flow; historical claims keep their own snapshot
    // commission_bonus_amount regardless of what happens to the tier
    // row later).
    const { error: deleteErr } = await supabase.from('commission_tiers').delete().eq('scope', 'global');
    if (deleteErr) throw deleteErr;

    const rows = tiers.map((t) => ({
      scope: 'global',
      ba_id: null,
      target_qualified_landlords: parseInt(t.targetQualifiedLandlords, 10),
      commission_percent: Number(t.commissionPercent),
    }));
    const { data: inserted, error: insertErr } = await supabase.from('commission_tiers').insert(rows).select();
    if (insertErr) throw insertErr;

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: 'commission_tiers_global_updated',
      targetType: 'commission_tiers',
      ipAddress: req.ip,
      metadata: { before: existing || [], after: inserted },
    });

    return res.json({ tiers: inserted });
  } catch (err) {
    logger.error('[payoutRules] updateCommissionTiers error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update commission tiers.' });
  }
}

async function setBaCommissionTierOverride(req, res) {
  try {
    const { baId } = req.params;
    const { tiers, clear } = req.body;

    const { data: existing, error: fetchErr } = await supabase
      .from('commission_tiers')
      .select('*')
      .eq('scope', 'ba_override')
      .eq('ba_id', baId);
    if (fetchErr) throw fetchErr;

    if (clear) {
      if (existing && existing.length > 0) {
        const { error } = await supabase.from('commission_tiers').delete().eq('scope', 'ba_override').eq('ba_id', baId);
        if (error) throw error;
      }
      logActivity({
        actorType: 'admin',
        actorId: ADMIN_ACTOR_ID,
        action: 'commission_tiers_ba_override_cleared',
        targetType: 'brand_ambassador',
        targetId: baId,
        ipAddress: req.ip,
        metadata: { before: existing || [], after: [] },
      });
      return res.json({ override: null });
    }

    const validationError = validateLadder(tiers);
    if (validationError) return res.status(400).json({ error: validationError });

    if (existing && existing.length > 0) {
      const { error } = await supabase.from('commission_tiers').delete().eq('scope', 'ba_override').eq('ba_id', baId);
      if (error) throw error;
    }

    const rows = tiers.map((t) => ({
      scope: 'ba_override',
      ba_id: baId,
      target_qualified_landlords: parseInt(t.targetQualifiedLandlords, 10),
      commission_percent: Number(t.commissionPercent),
    }));
    const { data: inserted, error: insertErr } = await supabase.from('commission_tiers').insert(rows).select();
    if (insertErr) throw insertErr;

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: 'commission_tiers_ba_override_set',
      targetType: 'brand_ambassador',
      targetId: baId,
      ipAddress: req.ip,
      metadata: { before: existing || [], after: inserted },
    });

    return res.json({ override: inserted });
  } catch (err) {
    logger.error('[payoutRules] setBaCommissionTierOverride error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update this BA\'s commission tier override.' });
  }
}

// ---------------------------------------------------------------------
// PHASE 19 - Qualification Job Dry-Run Mode.
//
// Admin-triggered manual run, distinct from the always-on
// BA_QUALIFICATION_DRY_RUN env flag (Phase 10 groundwork) - lets
// admin sanity-check a full cycle against real data on demand,
// especially right after a payout_rules/commission_tiers change,
// without waiting for or interfering with the next scheduled live
// run. Both routes below re-run the exact same side-effect-free check
// (runBaQualificationCheck({ forceDryRun: true })) - safe to call
// repeatedly, since dry-run mode never writes anything.
// ---------------------------------------------------------------------

async function runQualificationDryRun(req, res) {
  try {
    const result = await runBaQualificationCheck({ forceDryRun: true });
    return res.json({
      checked: result.checked,
      qualified: result.qualified,
      tiersCrossed: result.tiersCrossed,
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

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

async function downloadQualificationDryRunCsv(req, res) {
  try {
    const result = await runBaQualificationCheck({ forceDryRun: true });
    const rows = result.report || [];

    const lines = [['Claim ID', 'BA Code', 'BA Name', 'Landlord (snapshot name)', 'Would-be Base Payout (KES)', 'Would-be Commission Bonus (KES)', 'Would-be Tier Change'].join(',')];
    for (const r of rows) {
      const tierChange = r.wouldBeTierChange
        ? `${r.wouldBeTierChange.fromPercent}% -> ${r.wouldBeTierChange.toPercent}% (at ${r.wouldBeTierChange.targetQualifiedLandlords} qualified)`
        : '';
      lines.push(
        [
          csvEscape(r.claimId),
          csvEscape(r.baCode),
          csvEscape(r.baName),
          csvEscape(r.landlordSnapshotName),
          Number(r.wouldBePayoutAmount || 0).toFixed(2),
          Number(r.wouldBeCommissionBonusAmount || 0).toFixed(2),
          csvEscape(tierChange),
        ].join(',')
      );
    }
    lines.push('');
    lines.push(`Claims checked,${result.checked}`);
    lines.push(`Would qualify,${result.qualified}`);
    lines.push(`Commission tiers that would be crossed,${result.tiersCrossed}`);

    const filename = `ba-qualification-dry-run-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(lines.join('\n'));
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
  getCommissionTiers,
  updateCommissionTiers,
  setBaCommissionTierOverride,
  runQualificationDryRun,
  downloadQualificationDryRunCsv,
};
