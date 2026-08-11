// src/jobs/baQualification.job.js
//
// SECTION C (consolidated change instructions) - REPLACES the old
// claims-based qualification trigger entirely. The daily job now
// queries `landlords` directly:
//
//   ba_id is not null AND a completed payment exists AND at least
//   one unit is set up
//
// The moment both conditions are true, the landlord flips from
// ba_qualification_status = 'pending' to 'qualified' - automatically,
// no admin action, no ba_landlord_claims table involved (that table,
// and everything built on it, was removed in Section A - see
// 2026-08-remove-manual-ba-claims.sql).
//
// Qualification remains a ONE-TIME GATE per landlord (not
// re-evaluated repeatedly): once qualified, it stays qualified even if
// the landlord's subscription later lapses. If it lapses and later
// restarts, qualification is NOT re-run - per Section C, "earning
// simply resumes on their next completed payment" once the payout
// system (Section E, percentage commission - not yet implemented)
// exists to act on it.
//
// Keeps the same schedule and heartbeat/logging pattern as before
// (node-cron, upsert into system_heartbeats every run, same
// pending-record fan-out shape via runInBatches) - see Section C's
// "Keep unchanged" note.
//
// NOTE ON SCOPE: commission-tier / payout-amount computation (the old
// job's Phase 10 logic) is NOT reproduced here. That belongs to
// Section E (percentage-based commission, replacing commission_tiers
// entirely) and Section F (Payout Run), neither of which is part of
// this change set. This job's only job now is the qualification flip
// itself - computing and recording what a qualified landlord actually
// EARNS is a separate, not-yet-implemented piece of work.
//
// DRY_RUN (kept from the prior implementation): set
// BA_QUALIFICATION_DRY_RUN=true to compute who WOULD qualify and log
// a summary, without writing anything to the database or sending any
// notification. Safe to run repeatedly against real production data.

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

// Kept as a pure, exported utility (still covered by
// __tests__/baQualification.consecutiveMonths.test.js) even though
// the simplified Section C trigger below no longer requires a minimum
// number of consecutive months - only "a completed payment exists".
// A future Section E/F payout implementation may still want this.
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

async function runBaQualificationCheck(options = {}) {
  const startedAt = Date.now();
  // options.forceDryRun lets an admin-triggered manual run (Phase 19)
  // force dry-run mode regardless of the BA_QUALIFICATION_DRY_RUN env
  // var - the live scheduled run below never passes this, so its
  // behavior is completely unchanged.
  const dryRun = options.forceDryRun === true ? true : isDryRun();
  const summary = { checked: 0, qualified: 0, skippedInactiveBa: 0, errors: 0 };
  const reportRows = []; // Phase 19 - only populated in dry-run mode

  try {
    logger.info(`[cron] Running BA qualification check...${dryRun ? ' (DRY RUN)' : ''}`, new Date().toISOString());

    // ---- SECTION C: pending pool is now `landlords` directly - not
    // ba_landlord_claims (removed, Section A). ----
    const { data: pendingLandlords, error: landlordsErr } = await supabase
      .from('landlords')
      .select('id, full_name, ba_id, created_at')
      .not('ba_id', 'is', null)
      .eq('ba_qualification_status', 'pending');
    if (landlordsErr) throw landlordsErr;

    const landlords = pendingLandlords || [];
    summary.checked = landlords.length;
    if (landlords.length === 0) {
      await recordHeartbeat('ok', null, startedAt);
      logger.info('[cron] BA qualification check: nothing pending.');
      return { ...summary, report: reportRows };
    }

    // Confirm BA status for every distinct ba_id up front (skip
    // landlords for a BA who is not 'active'/'suspended' - e.g.
    // offboarded - without touching those rows at all).
    const baIds = [...new Set(landlords.map((l) => l.ba_id))];
    const { data: bas, error: basErr } = await supabase
      .from('brand_ambassadors')
      .select('id, ba_code, full_name, status')
      .in('id', baIds);
    if (basErr) throw basErr;
    const baById = new Map((bas || []).map((b) => [b.id, b]));

    const eligibleLandlords = landlords.filter((l) => {
      const ba = baById.get(l.ba_id);
      const eligible = ba && (ba.status === 'active' || ba.status === 'suspended');
      if (!eligible) summary.skippedInactiveBa += 1;
      return eligible;
    });

    // Bulk-fetch unit counts and completed-payment existence so each
    // landlord's check below is pure in-memory work, no per-landlord
    // round trip.
    const landlordIds = eligibleLandlords.map((l) => l.id);
    let unitsCountByLandlord = new Map();
    let hasCompletedPaymentByLandlord = new Set();
    if (landlordIds.length > 0) {
      const [{ data: units, error: unitsErr }, { data: payments, error: paymentsErr }] = await Promise.all([
        supabase.from('units').select('id, landlord_id').in('landlord_id', landlordIds),
        supabase
          .from('subscription_payments')
          .select('landlord_id')
          .in('landlord_id', landlordIds)
          .eq('status', 'completed'),
      ]);
      if (unitsErr) throw unitsErr;
      if (paymentsErr) throw paymentsErr;

      unitsCountByLandlord = (units || []).reduce((map, u) => {
        map.set(u.landlord_id, (map.get(u.landlord_id) || 0) + 1);
        return map;
      }, new Map());

      hasCompletedPaymentByLandlord = new Set((payments || []).map((p) => p.landlord_id));
    }

    // Notifications to send at the end (batched per BA - Phase 20
    // groundwork: one qualification event per BA per run, rather than
    // a separate push per landlord if several land for the same BA in
    // one run).
    const notificationsByBa = new Map(); // baId -> { qualifiedCount }

    await runInBatches(
      eligibleLandlords,
      async (landlord) => {
        const ba = baById.get(landlord.ba_id);
        const unitsCount = unitsCountByLandlord.get(landlord.id) || 0;
        const hasCompletedPayment = hasCompletedPaymentByLandlord.has(landlord.id);

        // SECTION C: the ONLY gate - payment completed AND at least
        // one unit set up. No consecutive-months requirement, no
        // unit-volume bracket, no commission-tier lookup (those
        // belong to the not-yet-implemented Section E/F payout
        // system).
        if (!hasCompletedPayment || unitsCount < 1) return;

        const qualifiedAt = new Date().toISOString();

        if (dryRun) {
          summary.qualified += 1;
          reportRows.push({
            landlordId: landlord.id,
            baId: landlord.ba_id,
            baCode: ba.ba_code,
            baName: ba.full_name,
            landlordName: landlord.full_name,
            wouldBeQualifiedUnitCount: unitsCount,
          });
          logger.info(
            `[cron] baQualification DRY RUN: landlord ${landlord.id} (BA ${landlord.ba_id}) would qualify - units=${unitsCount}, hasCompletedPayment=true`
          );
          return;
        }

        const { error: updateErr } = await supabase
          .from('landlords')
          .update({
            ba_qualification_status: 'qualified',
            ba_qualified_at: qualifiedAt,
          })
          .eq('id', landlord.id)
          .eq('ba_qualification_status', 'pending'); // idempotency guard against a double-run
        if (updateErr) throw updateErr;

        logActivity({
          actorType: 'system',
          action: 'ba_landlord_qualified',
          targetType: 'landlord',
          targetId: landlord.id,
          metadata: { baId: landlord.ba_id, unitsCount },
        });

        summary.qualified += 1;
        const notif = notificationsByBa.get(landlord.ba_id) || { qualifiedCount: 0 };
        notif.qualifiedCount += 1;
        notificationsByBa.set(landlord.ba_id, notif);
      },
      {
        concurrency: 5,
        onError: (err, landlord) => {
          summary.errors += 1;
          logger.error(`[cron] baQualification: failed to process landlord ${landlord.id}:`, err.message);
          captureException(err);
        },
      }
    );

    // ---- Queue this run's per-BA alerts through Phase 20's batching
    // layer, one per BA for THIS run same as before - the actual
    // across-runs batching happens inside queueBatchedNotification
    // itself. A lone event still goes out immediately, exactly as it
    // did before this phase existed. ----
    if (!dryRun) {
      for (const [baId, notif] of notificationsByBa.entries()) {
        try {
          if (notif.qualifiedCount > 0) {
            const msg =
              notif.qualifiedCount === 1
                ? 'One of your landlords just qualified.'
                : `${notif.qualifiedCount} of your landlords just qualified.`;
            await queueBatchedNotification(
              {
                recipientType: 'brand_ambassador',
                recipientId: baId,
                batchKey: 'ba_alert',
                eventType: 'qualified',
                fragment: `${notif.qualifiedCount} landlord${notif.qualifiedCount === 1 ? '' : 's'} qualified`,
                metadata: { qualifiedCount: notif.qualifiedCount },
              },
              () => notify('brand_ambassador', baId, null, msg, { category: 'account', title: 'Landlord qualified' })
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
          `Qualification dry-run: ${summary.checked} pending landlords checked, ${summary.qualified} would qualify.`,
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
