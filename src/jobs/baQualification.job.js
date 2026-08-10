// src/jobs/baQualification.job.js
//
// BUILD SPEC PHASE 10 - Payout Rules Engine, Qualification & Commission
// Tiers: flips a BA's landlord claim from 'pending' to 'qualified' once
// the matched landlord has genuinely paid enough, and layers in
// milestone commission tiers on top. Follows the exact scheduling/
// heartbeat pattern already used by baStaleApplicationReminder.job.js
// (node-cron, upsert into system_heartbeats every run) and the
// pending-record fan-out shape used by monthlyBilling.job.js
// (runInBatches, never a plain serial for...of).
//
// Runs daily, right after the monthly billing job so it's checking
// against that day's freshly-updated payment data.
//
// DRY_RUN (Phase 19 groundwork, requested directly in the Phase 10
// spec): set BA_QUALIFICATION_DRY_RUN=true to compute everything below
// - who WOULD qualify, what WOULD be paid, which tiers WOULD be
// crossed - and log a summary, without writing anything to the
// database or sending any notification. Safe to run repeatedly against
// real production data to sanity-check a change to payout_rules /
// commission_tiers before trusting the live job.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { logActivity } = require('../services/activityLog.service');
const { notify } = require('../services/notify.service');
const { queueBatchedNotification } = require('../services/notificationBatch.service');
const { runInBatches } = require('../utils/concurrency');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const JOB_NAME = 'ba_qualification';
const ADMIN_ACTOR_ID = 'super-admin';

function isDryRun() {
  return String(process.env.BA_QUALIFICATION_DRY_RUN || '').toLowerCase() === 'true';
}

async function recordHeartbeat(status, errorMessage, startedAt) {
  try {
    await supabase.from('system_heartbeats').upsert(
      {
        job_name: JOB_NAME,
        last_run_at: new Date().toISOString(),
        last_status: status,
        last_error: errorMessage || null,
        last_duration_ms: Date.now() - startedAt,
      },
      { onConflict: 'job_name' }
    );
  } catch (hbErr) {
    logger.error('[cron] baQualification: heartbeat write failed:', hbErr.message);
  }
}

// Adds `months` calendar months to a Date, returning a new Date -
// small local helper so this file has no extra dependency.
function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

// Computes how many CONSECUTIVE months of subscription coverage the
// landlord currently has, ending at their most recent completed
// payment. Completed payments are sorted ascending by paid_at; each
// payment "continues the chain" if it starts within a small grace
// window of the previous payment's coverage end (covers normal
// early-renewal / processing-lag timing), otherwise the chain resets
// and starts counting fresh from that payment. This deliberately
// means a landlord who paid, let their subscription lapse for a real
// gap, then paid again does NOT get credit for months before the gap
// - only the unbroken run counts, per the spec.
const CONSECUTIVE_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function computeConsecutiveMonths(completedPaymentsAsc) {
  let chainMonths = 0;
  let coverageEnd = null;
  for (const p of completedPaymentsAsc) {
    if (!p.paid_at || !p.period_months) continue;
    const paidAt = new Date(p.paid_at);
    const periodMonths = Number(p.period_months) || 0;
    if (coverageEnd !== null && paidAt.getTime() <= coverageEnd.getTime() + CONSECUTIVE_GRACE_MS) {
      const base = coverageEnd.getTime() > paidAt.getTime() ? coverageEnd : paidAt;
      coverageEnd = addMonths(base, periodMonths);
      chainMonths += periodMonths;
    } else {
      coverageEnd = addMonths(paidAt, periodMonths);
      chainMonths = periodMonths;
    }
  }
  return chainMonths;
}

async function resolvePayoutRule(baId, globalRule, overrideRulesByBaId) {
  return overrideRulesByBaId.get(baId) || globalRule || null;
}

async function resolveCommissionLadder(baId, globalLadder, overrideLaddersByBaId) {
  const override = overrideLaddersByBaId.get(baId);
  if (override && override.length > 0) return override;
  return globalLadder;
}

// Item 10 - unit-volume pricing. Resolves which ladder applies (BA's
// own override if they have one, else the global ladder) and picks
// the bracket whose [min_units, max_units] range contains unitsCount
// (max_units === null means "and up" - unbounded top bracket). Falls
// back to null (caller then uses payout_rules.amount) when no ladder
// is configured at all or none of its brackets match, so a site that
// hasn't set this up yet behaves exactly as before this feature
// existed.
function resolveUnitPricingLadder(baId, globalLadder, overrideLaddersByBaId) {
  const override = overrideLaddersByBaId.get(baId);
  if (override && override.length > 0) return override;
  return globalLadder;
}

function pickUnitPricingBracket(ladder, unitsCount) {
  if (!ladder || ladder.length === 0) return null;
  // Highest-matching bracket wins in the (should-never-happen, since
  // brackets are validated non-overlapping at write time) case of
  // ambiguity.
  const matches = ladder.filter((t) => unitsCount >= t.min_units && (t.max_units == null || unitsCount <= t.max_units));
  if (matches.length === 0) return null;
  return matches.reduce((best, t) => (t.min_units > best.min_units ? t : best));
}

async function runBaQualificationCheck(options = {}) {
  const startedAt = Date.now();
  // options.forceDryRun lets an admin-triggered manual run (Phase 19)
  // force dry-run mode regardless of the BA_QUALIFICATION_DRY_RUN env
  // var - the live scheduled run below never passes this, so its
  // behavior is completely unchanged.
  const dryRun = options.forceDryRun === true ? true : isDryRun();
  const summary = { checked: 0, qualified: 0, tiersCrossed: 0, skippedInactiveBa: 0, errors: 0 };
  const reportRows = []; // Phase 19 - only populated in dry-run mode

  try {
    logger.info(`[cron] Running BA qualification check...${dryRun ? ' (DRY RUN)' : ''}`, new Date().toISOString());

    // ---- Load everything the job needs up front, in bulk. ----
    const [
      { data: pendingClaims, error: claimsErr },
      { data: globalRule, error: globalRuleErr },
      { data: overrideRules, error: overrideRulesErr },
      { data: globalTiers, error: globalTiersErr },
      { data: overrideTiers, error: overrideTiersErr },
      { data: globalUnitTiers, error: globalUnitTiersErr },
      { data: overrideUnitTiers, error: overrideUnitTiersErr },
    ] = await Promise.all([
      supabase
        .from('ba_landlord_claims')
        .select('id, ba_id, matched_landlord_id, submitted_name, qualification_status, match_status')
        .eq('match_status', 'matched')
        .eq('qualification_status', 'pending'),
      supabase.from('payout_rules').select('*').eq('scope', 'global').maybeSingle(),
      supabase.from('payout_rules').select('*').eq('scope', 'ba_override'),
      supabase.from('commission_tiers').select('*').eq('scope', 'global').order('target_qualified_landlords', { ascending: true }),
      supabase.from('commission_tiers').select('*').eq('scope', 'ba_override').order('target_qualified_landlords', { ascending: true }),
      supabase.from('unit_pricing_tiers').select('*').eq('scope', 'global').order('min_units', { ascending: true }),
      supabase.from('unit_pricing_tiers').select('*').eq('scope', 'ba_override').order('min_units', { ascending: true }),
    ]);
    if (claimsErr) throw claimsErr;
    if (globalRuleErr) throw globalRuleErr;
    if (overrideRulesErr) throw overrideRulesErr;
    if (globalTiersErr) throw globalTiersErr;
    if (overrideTiersErr) throw overrideTiersErr;
    if (globalUnitTiersErr) throw globalUnitTiersErr;
    if (overrideUnitTiersErr) throw overrideUnitTiersErr;

    const claims = pendingClaims || [];
    summary.checked = claims.length;
    if (claims.length === 0) {
      await recordHeartbeat('ok', null, startedAt);
      logger.info('[cron] BA qualification check: nothing pending.');
      return { ...summary, report: reportRows };
    }

    const overrideRulesByBaId = new Map((overrideRules || []).map((r) => [r.ba_id, r]));
    const overrideLaddersByBaId = new Map();
    for (const t of overrideTiers || []) {
      const list = overrideLaddersByBaId.get(t.ba_id) || [];
      list.push(t);
      overrideLaddersByBaId.set(t.ba_id, list);
    }
    const overrideUnitLaddersByBaId = new Map();
    for (const t of overrideUnitTiers || []) {
      const list = overrideUnitLaddersByBaId.get(t.ba_id) || [];
      list.push(t);
      overrideUnitLaddersByBaId.set(t.ba_id, list);
    }

    // Confirm BA status for every distinct ba_id up front (skip
    // claims for a BA who is not 'active'/'suspended' - e.g.
    // offboarded, Phase 16 - without touching those rows at all).
    const baIds = [...new Set(claims.map((c) => c.ba_id))];
    const { data: bas, error: basErr } = await supabase
      .from('brand_ambassadors')
      .select('id, ba_code, full_name, status, current_commission_percent')
      .in('id', baIds);
    if (basErr) throw basErr;
    const baById = new Map((bas || []).map((b) => [b.id, b]));

    const eligibleClaims = claims.filter((c) => {
      const ba = baById.get(c.ba_id);
      const eligible = ba && (ba.status === 'active' || ba.status === 'suspended');
      if (!eligible) summary.skippedInactiveBa += 1;
      return eligible;
    });

    // Bulk-fetch matched landlords' unit counts and payment history so
    // each claim's check below is pure in-memory work, no per-claim
    // round trip.
    const landlordIds = [...new Set(eligibleClaims.map((c) => c.matched_landlord_id).filter(Boolean))];
    let unitsCountByLandlord = new Map();
    let paymentsByLandlord = new Map();
    if (landlordIds.length > 0) {
      const [{ data: units, error: unitsErr }, { data: payments, error: paymentsErr }] = await Promise.all([
        supabase.from('units').select('id, landlord_id').in('landlord_id', landlordIds),
        supabase
          .from('subscription_payments')
          .select('landlord_id, period_months, paid_at, status')
          .in('landlord_id', landlordIds)
          .eq('status', 'completed')
          .order('paid_at', { ascending: true }),
      ]);
      if (unitsErr) throw unitsErr;
      if (paymentsErr) throw paymentsErr;

      unitsCountByLandlord = (units || []).reduce((map, u) => {
        map.set(u.landlord_id, (map.get(u.landlord_id) || 0) + 1);
        return map;
      }, new Map());

      paymentsByLandlord = (payments || []).reduce((map, p) => {
        const list = map.get(p.landlord_id) || [];
        list.push(p);
        map.set(p.landlord_id, list);
        return map;
      }, new Map());
    }

    // Notifications to send at the end (batched per BA - Phase 20
    // groundwork: one qualification event and one tier-crossed event
    // per BA per run, rather than a separate push per claim if
    // several land for the same BA in one run).
    const notificationsByBa = new Map(); // baId -> { qualifiedCount, tierCrossed: {percent, target} | null }

    await runInBatches(
      eligibleClaims,
      async (claim) => {
        const ba = baById.get(claim.ba_id);
        const rule = await resolvePayoutRule(claim.ba_id, globalRule, overrideRulesByBaId);
        if (!rule) return; // no global rule configured at all - nothing to check against yet

        const unitsCount = unitsCountByLandlord.get(claim.matched_landlord_id) || 0;
        const payments = paymentsByLandlord.get(claim.matched_landlord_id) || [];
        const consecutiveMonths = computeConsecutiveMonths(payments);

        const meetsMonths = consecutiveMonths >= rule.required_consecutive_months;
        const meetsUnits = unitsCount >= rule.min_units;
        if (!meetsMonths || !meetsUnits) return;

        const qualifiedAt = new Date().toISOString();

        // Item 10 - resolve the BASE payout from the unit-volume
        // bracket the landlord's unit count falls into, if any ladder
        // is configured; otherwise fall back to the flat
        // payout_rules.amount exactly as before this feature existed.
        const unitLadder = resolveUnitPricingLadder(claim.ba_id, globalUnitTiers || [], overrideUnitLaddersByBaId);
        const unitBracket = pickUnitPricingBracket(unitLadder, unitsCount);
        const payoutAmount = unitBracket ? Number(unitBracket.amount) : Number(rule.amount);
        const unitPricingTierId = unitBracket ? unitBracket.id : null;

        if (dryRun) {
          summary.qualified += 1;

          // Read-only simulation of the same lifetime-count + tier
          // check the live path does below - never writes anything,
          // just projects what WOULD happen if this claim qualified
          // right now.
          let wouldBeTierChange = null;
          let wouldBeCommissionBonusAmount = 0;
          try {
            const { count: lifetimeQualified, error: countErr } = await supabase
              .from('ba_landlord_claims')
              .select('id', { count: 'exact', head: true })
              .eq('ba_id', claim.ba_id)
              .in('qualification_status', ['qualified', 'paid']);
            if (countErr) throw countErr;

            const projectedLifetime = (lifetimeQualified || 0) + 1;
            const ladder = await resolveCommissionLadder(claim.ba_id, globalTiers || [], overrideLaddersByBaId);
            const sortedLadder = [...ladder].sort((a, b) => a.target_qualified_landlords - b.target_qualified_landlords);
            const metTier = [...sortedLadder].reverse().find((t) => projectedLifetime >= t.target_qualified_landlords);
            const currentPercent = Number(ba.current_commission_percent) || 0;

            if (metTier && Number(metTier.commission_percent) > currentPercent) {
              wouldBeTierChange = {
                fromPercent: currentPercent,
                toPercent: Number(metTier.commission_percent),
                targetQualifiedLandlords: metTier.target_qualified_landlords,
              };
              wouldBeCommissionBonusAmount = Math.round(payoutAmount * (Number(metTier.commission_percent) / 100));
              summary.tiersCrossed += 1;
            }
          } catch (simErr) {
            // Tier simulation is a nice-to-have on top of the report -
            // never let it fail the qualification projection itself.
            logger.warn(`[cron] baQualification DRY RUN: tier simulation skipped for claim ${claim.id}:`, simErr.message);
          }

          reportRows.push({
            claimId: claim.id,
            baId: claim.ba_id,
            baCode: ba.ba_code,
            baName: ba.full_name,
            landlordSnapshotName: claim.submitted_name || 'Unknown',
            wouldBePayoutAmount: payoutAmount,
            wouldBeUnitBracket: unitBracket
              ? { minUnits: unitBracket.min_units, maxUnits: unitBracket.max_units, amount: Number(unitBracket.amount) }
              : null,
            wouldBeCommissionBonusAmount,
            wouldBeTierChange,
          });

          logger.info(
            `[cron] baQualification DRY RUN: claim ${claim.id} (BA ${claim.ba_id}) would qualify - months=${consecutiveMonths}/${rule.required_consecutive_months}, units=${unitsCount}/${rule.min_units}, payoutAmount=${payoutAmount}${unitBracket ? ` (unit bracket ${unitBracket.min_units}-${unitBracket.max_units ?? '+'})` : ' (flat rate, no bracket configured/matched)'}`
          );
          return;
        }

        const { error: updateErr } = await supabase
          .from('ba_landlord_claims')
          .update({
            qualification_status: 'qualified',
            qualified_at: qualifiedAt,
            payout_amount: payoutAmount,
            unit_pricing_tier_id: unitPricingTierId,
            qualified_unit_count: unitsCount,
            updated_at: qualifiedAt,
          })
          .eq('id', claim.id)
          .eq('qualification_status', 'pending'); // idempotency guard against a double-run
        if (updateErr) throw updateErr;

        logActivity({
          actorType: 'system',
          action: 'ba_claim_qualified',
          targetType: 'ba_landlord_claims',
          targetId: claim.id,
          metadata: { baId: claim.ba_id, landlordId: claim.matched_landlord_id, consecutiveMonths, payoutAmount, unitsCount, unitPricingTierId },
        });

        summary.qualified += 1;
        const notif = notificationsByBa.get(claim.ba_id) || { qualifiedCount: 0, tierCrossed: null };
        notif.qualifiedCount += 1;
        notificationsByBa.set(claim.ba_id, notif);

        // Recompute this BA's lifetime qualified-landlord count and
        // check the commission ladder for a newly-crossed tier.
        const { count: lifetimeQualified, error: countErr } = await supabase
          .from('ba_landlord_claims')
          .select('id', { count: 'exact', head: true })
          .eq('ba_id', claim.ba_id)
          .in('qualification_status', ['qualified', 'paid']);
        if (countErr) throw countErr;

        const ladder = await resolveCommissionLadder(claim.ba_id, globalTiers || [], overrideLaddersByBaId);
        const sortedLadder = [...ladder].sort((a, b) => a.target_qualified_landlords - b.target_qualified_landlords);
        const metTier = [...sortedLadder].reverse().find((t) => (lifetimeQualified || 0) >= t.target_qualified_landlords);

        let commissionBonusAmount = 0;
        let commissionTierId = null;

        if (metTier) {
          commissionTierId = metTier.id;
          // Only ever increases current_commission_percent - never
          // decreases, even if a future claim gets disputed/removed.
          const currentPercent = Number(ba.current_commission_percent) || 0;
          if (Number(metTier.commission_percent) > currentPercent) {
            const { error: baUpdateErr } = await supabase
              .from('brand_ambassadors')
              .update({ current_commission_percent: metTier.commission_percent, updated_at: qualifiedAt })
              .eq('id', claim.ba_id);
            if (baUpdateErr) throw baUpdateErr;

            // Update our in-memory copy so subsequent claims for the
            // same BA within this same run see the new percent too.
            ba.current_commission_percent = metTier.commission_percent;

            logActivity({
              actorType: 'system',
              action: 'ba_commission_tier_crossed',
              targetType: 'brand_ambassador',
              targetId: claim.ba_id,
              metadata: { newPercent: metTier.commission_percent, targetQualifiedLandlords: metTier.target_qualified_landlords, lifetimeQualified },
            });

            summary.tiersCrossed += 1;
            notif.tierCrossed = { percent: metTier.commission_percent, target: metTier.target_qualified_landlords };
            notificationsByBa.set(claim.ba_id, notif);

            // This claim itself earns the bonus at the moment it
            // crosses the tier. Claims that qualified before this
            // tier was reached keep commission_bonus_amount = 0 -
            // tiers apply going forward, never retroactively.
            commissionBonusAmount = Math.round(payoutAmount * (Number(metTier.commission_percent) / 100));
          }
        }

        if (commissionBonusAmount > 0 || commissionTierId) {
          const { error: bonusUpdateErr } = await supabase
            .from('ba_landlord_claims')
            .update({ commission_bonus_amount: commissionBonusAmount, commission_tier_id: commissionTierId })
            .eq('id', claim.id);
          if (bonusUpdateErr) throw bonusUpdateErr;
        }
      },
      {
        concurrency: 5,
        onError: (err, claim) => {
          summary.errors += 1;
          logger.error(`[cron] baQualification: failed to process claim ${claim.id}:`, err.message);
          captureException(err);
        },
      }
    );

    // ---- Queue this run's per-BA alerts through Phase 20's batching
    // layer, one per BA for THIS run same as before - the actual
    // across-runs batching (so a BA isn't pinged separately if this
    // job's alert lands within the same short window as, say, an
    // earlier manual dry-run's live counterpart, or a future
    // real-time event source) happens inside queueBatchedNotification
    // itself. A lone event still goes out immediately, exactly as it
    // did before this phase existed. ----
    if (!dryRun) {
      for (const [baId, notif] of notificationsByBa.entries()) {
        try {
          if (notif.qualifiedCount > 0) {
            const msg =
              notif.qualifiedCount === 1
                ? 'One of your landlords just qualified - your payout has been recorded.'
                : `${notif.qualifiedCount} of your landlords just qualified - your payouts have been recorded.`;
            await queueBatchedNotification(
              {
                recipientType: 'brand_ambassador',
                recipientId: baId,
                batchKey: 'ba_alert',
                eventType: 'qualified',
                fragment: `${notif.qualifiedCount} landlord${notif.qualifiedCount === 1 ? '' : 's'} qualified`,
                metadata: { qualifiedCount: notif.qualifiedCount },
              },
              () => notify('brand_ambassador', baId, null, msg, { category: 'account', title: 'Landlord qualified for payout' })
            );
          }
          if (notif.tierCrossed) {
            const msg = `You've crossed ${notif.tierCrossed.target} qualified landlords - your commission is now ${notif.tierCrossed.percent}%!`;
            await queueBatchedNotification(
              {
                recipientType: 'brand_ambassador',
                recipientId: baId,
                batchKey: 'ba_alert',
                eventType: 'tier_crossed',
                fragment: `new commission tier: ${notif.tierCrossed.percent}%`,
                metadata: { percent: notif.tierCrossed.percent, target: notif.tierCrossed.target },
              },
              () => notify('brand_ambassador', baId, null, msg, { category: 'account', title: 'New commission tier reached', urgent: true })
            );
          }
        } catch (notifyErr) {
          logger.error(`[cron] baQualification: notify failed for BA ${baId}:`, notifyErr.message);
          captureException(notifyErr);
        }
      }
    } else {
      // Phase 19 - a dry run never touches a BA's notifications inbox
      // (nothing actually happened for them yet); it instead posts one
      // summary to admin's own inbox, the same channel every other
      // admin-facing job output already uses.
      try {
        await notify(
          'admin',
          ADMIN_ACTOR_ID,
          null,
          `Qualification dry-run: ${summary.checked} pending claims checked, ${summary.qualified} would qualify, ${summary.tiersCrossed} commission tier(s) would be crossed.`,
          { category: 'account', title: 'BA qualification dry-run complete' }
        );
      } catch (notifyErr) {
        logger.error('[cron] baQualification: dry-run admin summary notify failed:', notifyErr.message);
        captureException(notifyErr);
      }
    }

    await recordHeartbeat('ok', null, startedAt);
    logger.info(`[cron] BA qualification check complete.${dryRun ? ' (DRY RUN - nothing written)' : ''}`, summary);
    return { ...summary, report: reportRows };
  } catch (err) {
    logger.error('[cron] baQualification: job failed:', err.message);
    captureException(err);
    await recordHeartbeat('error', err.message, startedAt);
    return { ...summary, report: reportRows };
  }
}

function startBaQualificationJob() {
  // Daily at 00:05 - right after monthlyBilling (00:01) and
  // subscriptionReminders (00:00) so it checks against the day's
  // freshly-updated payment/subscription data.
  cron.schedule('5 0 * * *', async () => {
    await runBaQualificationCheck();
  });
  logger.info(`[cron] BA qualification job scheduled (daily at 00:05)${isDryRun() ? ' - DRY RUN mode is ON via BA_QUALIFICATION_DRY_RUN' : ''}.`);
}

module.exports = { startBaQualificationJob, runBaQualificationCheck, computeConsecutiveMonths };
