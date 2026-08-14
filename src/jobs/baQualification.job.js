// src/jobs/baQualification.job.js
//
// SECTION C (consolidated change instructions) - REPLACES the old
// claims-based qualification trigger entirely.
//
// FIX (direct request: "no matter how much a landlord first signs up
// with, that account qualifies for payment... right now all are just
// saying 0 qualifying"): qualification and commission are now
// primarily handled INLINE, the instant a landlord's first
// subscription payment completes - see the ba_qualification_status /
// recordCommissionForPayment block in payment.controller.js
// (processSubscriptionPaymentCallback) and
// landlordManualSubscriptionPayment.controller.js
// (confirmManualSubscriptionPayment). This job now exists as a
// SAFETY NET / BACKFILL only - it catches:
//   (a) any landlord who somehow still has ba_qualification_status =
//       'pending' despite a completed payment (e.g. the inline update
//       failed, or a payment completed before this fix was deployed -
//       exactly the "Pending" landlords stuck in a BA's dashboard
//       that prompted this fix), and
//   (b) commission that was never recorded for that landlord's first
//       payment, for the same reason.
// The unit-count requirement the old version of this job had ("at
// least one unit set up") is REMOVED per direct instruction -
// qualification is based on signing up and paying, nothing else.
//
// Keeps the same schedule and heartbeat/logging pattern as before
// (node-cron, upsert into system_heartbeats every run) - see Section
// C's "Keep unchanged" note.
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
const { recordCommissionForPayment } = require('../services/baCommission.service');
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

    // Bulk-fetch each eligible landlord's EARLIEST completed payment -
    // used both to gate qualification (hasCompletedPayment) and, for
    // any landlord this flips to qualified below, to backfill a
    // commission record if payment.controller.js's inline path never
    // got the chance to (e.g. this landlord's first payment completed
    // before that fix was deployed). No unit-count fetch/gate anymore -
    // removed per direct instruction, see the top-of-file comment.
    const landlordIds = eligibleLandlords.map((l) => l.id);
    let earliestPaymentByLandlord = new Map();
    if (landlordIds.length > 0) {
      const { data: payments, error: paymentsErr } = await supabase
        .from('subscription_payments')
        .select('id, landlord_id, amount, paid_at')
        .in('landlord_id', landlordIds)
        .eq('status', 'completed')
        .order('paid_at', { ascending: true });
      if (paymentsErr) throw paymentsErr;

      for (const p of payments || []) {
        // First row wins per landlord_id, since the query is already
        // ordered ascending by paid_at - later rows for the same
        // landlord are renewals, not their qualifying payment.
        if (!earliestPaymentByLandlord.has(p.landlord_id)) {
          earliestPaymentByLandlord.set(p.landlord_id, p);
        }
      }
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
        const earliestPayment = earliestPaymentByLandlord.get(landlord.id);

        // FIX (direct request): the ONLY gate now is a completed
        // payment - no unit-count requirement, no consecutive-months
        // requirement, no commission-tier lookup.
        if (!earliestPayment) return;

        const qualifiedAt = new Date().toISOString();

        if (dryRun) {
          summary.qualified += 1;
          reportRows.push({
            landlordId: landlord.id,
            baId: landlord.ba_id,
            baCode: ba.ba_code,
            baName: ba.full_name,
            landlordName: landlord.full_name,
          });
          logger.info(
            `[cron] baQualification DRY RUN: landlord ${landlord.id} (BA ${landlord.ba_id}) would qualify - hasCompletedPayment=true`
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

        // BACKFILL: this landlord's first payment may have completed
        // before the inline qualify-and-record fix existed (or the
        // inline attempt failed) - recordCommissionForPayment is
        // idempotent (unique index on subscription_payment_id), so
        // calling it here is always safe even if it was already
        // recorded inline.
        await recordCommissionForPayment({
          id: earliestPayment.id,
          landlord_id: landlord.id,
          amount: earliestPayment.amount,
          paid_at: earliestPayment.paid_at,
        });

        logActivity({
          actorType: 'system',
          action: 'ba_landlord_qualified',
          targetType: 'landlord',
          targetId: landlord.id,
          metadata: { baId: landlord.ba_id, trigger: 'qualification_job_backfill' },
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

    // ---- DIRECT REQUEST: BA attribution/qualification is now
    // per-PROPERTY for any property added via "add a property" (see
    // sql/2026-08-per-property-ba-attribution.sql and
    // property.controller.js's completePropertyPurchase, which
    // qualifies these inline the moment that property's own payment
    // completes). This second pass is the same safety-net/backfill
    // role as the landlord pass above, just scoped to properties.ba_id
    // instead of landlords.ba_id - it never touches the landlord pass's
    // results and the two are independent (a landlord can have one
    // property qualified under BA-A here and their original property
    // qualified under BA-B above). ----
    const propertySummary = await runPropertyQualificationBackfill(dryRun, reportRows);
    logger.info(`[cron] BA property-level qualification backfill complete.${dryRun ? ' (DRY RUN)' : ''}`, propertySummary);

    return {
      ...summary,
      propertiesChecked: propertySummary.checked,
      propertiesQualified: propertySummary.qualified,
      propertiesErrors: propertySummary.errors,
      report: reportRows,
    };
  } catch (err) {
    logger.error('[cron] baQualification: job failed:', err.message);
    captureException(err);
    await recordHeartbeat('error', err.message, startedAt);
    return { ...summary, report: reportRows };
  }
}

// Property-scoped counterpart to the landlord-level pass above. Same
// role (safety net/backfill for the inline qualify-on-payment path,
// this time in property.controller.js's completePropertyPurchase),
// same idempotency guard (only updates rows still 'pending'), same
// dry-run behaviour (nothing written, rows appended to the same
// report). Kept as a separate function so the two passes stay easy to
// reason about independently.
async function runPropertyQualificationBackfill(dryRun, reportRows) {
  const summary = { checked: 0, qualified: 0, errors: 0 };
  try {
    const { data: pendingProperties, error: propsErr } = await supabase
      .from('properties')
      .select('id, landlord_id, name, ba_id, created_at')
      .not('ba_id', 'is', null)
      .eq('ba_qualification_status', 'pending');
    if (propsErr) throw propsErr;

    const properties = pendingProperties || [];
    summary.checked = properties.length;
    if (properties.length === 0) return summary;

    const baIds = [...new Set(properties.map((p) => p.ba_id))];
    const { data: bas, error: basErr } = await supabase
      .from('brand_ambassadors')
      .select('id, ba_code, full_name, status')
      .in('id', baIds);
    if (basErr) throw basErr;
    const baById = new Map((bas || []).map((b) => [b.id, b]));

    const eligibleProperties = properties.filter((p) => {
      const ba = baById.get(p.ba_id);
      return ba && (ba.status === 'active' || ba.status === 'suspended');
    });

    // Each property's own completed purchase/renewal payment(s) -
    // property_payments rows pointing back at it via created_property_id
    // or renews_property_id, same "earliest completed payment"
    // qualifying evidence as the landlord pass, just scoped per property.
    const propertyIds = eligibleProperties.map((p) => p.id);
    let earliestPaymentByProperty = new Map();
    if (propertyIds.length > 0) {
      const { data: payments, error: paymentsErr } = await supabase
        .from('property_payments')
        .select('id, created_property_id, renews_property_id, amount, ba_id, paid_at')
        .eq('status', 'completed')
        .or(`created_property_id.in.(${propertyIds.join(',')}),renews_property_id.in.(${propertyIds.join(',')})`)
        .order('paid_at', { ascending: true });
      if (paymentsErr) throw paymentsErr;

      for (const p of payments || []) {
        const propertyId = p.created_property_id || p.renews_property_id;
        if (!propertyId) continue;
        if (!earliestPaymentByProperty.has(propertyId)) {
          earliestPaymentByProperty.set(propertyId, p);
        }
      }
    }

    await runInBatches(
      eligibleProperties,
      async (property) => {
        const earliestPayment = earliestPaymentByProperty.get(property.id);
        if (!earliestPayment) return;

        const qualifiedAt = new Date().toISOString();

        if (dryRun) {
          summary.qualified += 1;
          const ba = baById.get(property.ba_id);
          reportRows.push({
            propertyId: property.id,
            landlordId: property.landlord_id,
            baId: property.ba_id,
            baCode: ba?.ba_code,
            baName: ba?.full_name,
            propertyName: property.name,
          });
          logger.info(`[cron] baQualification DRY RUN: property ${property.id} (BA ${property.ba_id}) would qualify.`);
          return;
        }

        const { error: updateErr } = await supabase
          .from('properties')
          .update({ ba_qualification_status: 'qualified', ba_qualified_at: qualifiedAt })
          .eq('id', property.id)
          .eq('ba_qualification_status', 'pending'); // idempotency guard against a double-run
        if (updateErr) throw updateErr;

        // BACKFILL, same reasoning as the landlord pass: this
        // property's inline qualify-and-record attempt in
        // completePropertyPurchase may have failed or predated this
        // fix. recordCommissionForPayment(..., { baId, qualificationStatus })
        // is idempotent (unique index on subscription_payment_id) once
        // that payment type is wired into commission recording - safe
        // to call here in the meantime with no effect if it isn't yet.
        await recordCommissionForPayment(
          { id: earliestPayment.id, landlord_id: property.landlord_id, amount: earliestPayment.amount, paid_at: earliestPayment.paid_at },
          { baId: property.ba_id, qualificationStatus: 'qualified' }
        );

        logActivity({
          actorType: 'system',
          action: 'ba_property_qualified',
          targetType: 'property',
          targetId: property.id,
          metadata: { baId: property.ba_id, landlordId: property.landlord_id, trigger: 'qualification_job_backfill' },
        });

        summary.qualified += 1;
      },
      {
        concurrency: 5,
        onError: (err, property) => {
          summary.errors += 1;
          logger.error(`[cron] baQualification: failed to process property ${property.id}:`, err.message);
          captureException(err);
        },
      }
    );

    return summary;
  } catch (err) {
    summary.errors += 1;
    logger.error('[cron] baQualification: property-level backfill failed:', err.message);
    captureException(err);
    return summary;
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
