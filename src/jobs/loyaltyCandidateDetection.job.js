// src/jobs/loyaltyCandidateDetection.job.js
//
// P5 (loyalty-discount-roadmap.md): "findConsecutiveLandlordCandidates
// only runs when an admin opens the page and checks. Easy for the
// program to go unused."
//
// Work item 1 (always on): a weekly cron job - same
// cron/heartbeat/dry-run shape as baQualification.job.js - runs
// candidate detection and notifies admin of NEW candidates via the
// same in-app notify() pattern every other admin-facing job uses.
//
// Work item 2 (optional, off by default): auto-grant at a
// conservative default percentage for landlords past a HIGHER
// threshold than the base eligibility bar (e.g. 8+ months vs the
// normal 4-month minimum). Admin can still review/revoke every
// auto-grant afterwards - this never removes the admin's control,
// it just removes the need to remember to look.
//
// "NEW candidate" dedup: findConsecutiveLandlordCandidates already
// excludes any landlord with an active grant covering their current
// month count (see landlordLoyalty.service.js), so re-running
// detection naturally stops re-surfacing someone once they're
// granted. What it does NOT prevent is re-notifying the admin every
// week about the same UNGRANTED candidate. To avoid that noise, this
// job records a 'loyalty_candidate_notified' activity_logs row per
// landlord/months-figure each time it notifies, and treats a
// candidate as "new" only if it has never been notified before, or
// their consecutive-months figure has grown since the last notify
// (same "only resurface on progress" rule the service already uses
// for grants).

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { logActivity } = require('../services/activityLog.service');
const { notify } = require('../services/notify.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');
const {
  findConsecutiveLandlordCandidates,
  bulkGrantLoyaltyDiscount,
  DEFAULT_MIN_CONSECUTIVE_MONTHS,
} = require('../services/landlordLoyalty.service');

const JOB_NAME = 'loyalty_candidate_detection';
const ADMIN_ACTOR_ID = 'super-admin';
const NOTIFIED_ACTION = 'loyalty_candidate_notified';

// Auto-grant is opt-in and deliberately conservative - see roadmap
// P5's own "Optional" wording. All three are env-configurable so
// product can tune without a redeploy of logic, only of env vars.
function isAutoGrantEnabled() {
  return String(process.env.LOYALTY_AUTO_GRANT_ENABLED || '').toLowerCase() === 'true';
}
function autoGrantMonthsThreshold() {
  const raw = Number(process.env.LOYALTY_AUTO_GRANT_MONTHS_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : 8; // "8+ months" per roadmap example
}
function autoGrantPercentage() {
  const raw = Number(process.env.LOYALTY_AUTO_GRANT_PERCENTAGE);
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 5; // conservative default
}
function isDryRun() {
  return String(process.env.LOYALTY_CANDIDATE_DETECTION_DRY_RUN || '').toLowerCase() === 'true';
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
    logger.error('[cron] loyaltyCandidateDetection: heartbeat write failed:', hbErr.message);
  }
}

// Pure function (no supabase calls) so it's directly unit-testable -
// see __tests__/loyaltyCandidateDetection.dedup.test.js. Given the
// full candidate list and a map of landlordId -> months they were
// last notified at, returns only the candidates that are actually
// new (never notified) or have progressed past their last notify.
function filterNewCandidates(candidates, lastNotifiedMonthsByLandlord) {
  return candidates.filter((c) => {
    const lastNotified = lastNotifiedMonthsByLandlord.get(c.landlordId);
    if (lastNotified == null) return true;
    return c.consecutiveMonths > lastNotified;
  });
}

async function loadLastNotifiedMonths() {
  // Most recent notify per landlord wins - a landlord notified twice
  // (once at 5 months, later at 9) should only be compared against
  // the most recent (9), not the oldest.
  const { data, error } = await supabase
    .from('activity_logs')
    .select('target_id, metadata, created_at')
    .eq('action', NOTIFIED_ACTION)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const map = new Map();
  for (const row of data || []) {
    const months = Number(row.metadata?.consecutiveMonths);
    if (row.target_id && Number.isFinite(months)) {
      map.set(row.target_id, months); // later rows overwrite earlier ones (ascending order)
    }
  }
  return map;
}

async function runLoyaltyCandidateDetection() {
  const startedAt = Date.now();
  const dryRun = isDryRun();
  const summary = { checked: 0, newCandidates: 0, autoGranted: 0, errors: 0 };

  try {
    const candidates = await findConsecutiveLandlordCandidates(DEFAULT_MIN_CONSECUTIVE_MONTHS);
    summary.checked = candidates.length;

    const lastNotifiedMonths = await loadLastNotifiedMonths();
    const newCandidates = filterNewCandidates(candidates, lastNotifiedMonths);
    summary.newCandidates = newCandidates.length;

    if (newCandidates.length === 0) {
      await recordHeartbeat('ok', null, startedAt);
      logger.info('[cron] loyaltyCandidateDetection: no new candidates this run.');
      return summary;
    }

    if (dryRun) {
      logger.info(
        `[cron] loyaltyCandidateDetection: DRY RUN - would notify admin of ${newCandidates.length} new candidate(s).`,
        newCandidates.map((c) => ({ landlordId: c.landlordId, months: c.consecutiveMonths }))
      );
      await recordHeartbeat('ok', null, startedAt);
      return summary;
    }

    // Work item 2 (optional): auto-grant a conservative default to
    // candidates past the higher threshold. Runs BEFORE the admin
    // notification below so the notify text can distinguish
    // "auto-granted" from "awaiting your review".
    const autoGrantedIds = new Set();
    if (isAutoGrantEnabled()) {
      const threshold = autoGrantMonthsThreshold();
      const pct = autoGrantPercentage();
      const eligibleForAutoGrant = newCandidates.filter((c) => c.consecutiveMonths >= threshold);

      if (eligibleForAutoGrant.length > 0) {
        const result = await bulkGrantLoyaltyDiscount({
          landlordIds: eligibleForAutoGrant.map((c) => c.landlordId),
          discountPercentage: pct,
          adminId: ADMIN_ACTOR_ID,
          note: `Auto-granted by ${JOB_NAME} job (>= ${threshold} consecutive months). Review/revoke as needed.`,
        });

        for (const granted of result.granted) autoGrantedIds.add(granted.landlord_id);
        summary.autoGranted = result.granted.length;
        summary.errors += result.errors.length;

        logActivity({
          actorType: 'system',
          action: 'loyalty_discount_auto_granted',
          targetType: 'landlord_loyalty_discounts',
          targetId: result.batchId,
          metadata: {
            landlordIds: eligibleForAutoGrant.map((c) => c.landlordId),
            discountPercentage: pct,
            threshold,
            granted: result.granted.length,
            errors: result.errors,
          },
        });
      }
    }

    // Record a 'notified' marker for every new candidate (auto-granted
    // or not) so next week's run doesn't re-flag them at the same
    // months figure, and so the admin summary below is accurate.
    for (const c of newCandidates) {
      logActivity({
        actorType: 'system',
        action: NOTIFIED_ACTION,
        targetType: 'landlord',
        targetId: c.landlordId,
        metadata: { consecutiveMonths: c.consecutiveMonths, autoGranted: autoGrantedIds.has(c.landlordId) },
      });
    }

    const awaitingReviewCount = newCandidates.length - autoGrantedIds.size;
    const parts = [];
    if (awaitingReviewCount > 0) {
      parts.push(
        `${awaitingReviewCount} landlord${awaitingReviewCount === 1 ? '' : 's'} newly eligible for a loyalty discount - review on the Loyalty Discounts page.`
      );
    }
    if (autoGrantedIds.size > 0) {
      parts.push(`${autoGrantedIds.size} auto-granted a ${autoGrantPercentage()}% discount (reviewable/revocable).`);
    }

    try {
      await notify('admin', ADMIN_ACTOR_ID, null, parts.join(' '), {
        category: 'account',
        title: 'New loyalty discount candidates',
      });
    } catch (notifyErr) {
      logger.error('[cron] loyaltyCandidateDetection: admin notify failed:', notifyErr.message);
      captureException(notifyErr);
    }

    await recordHeartbeat('ok', null, startedAt);
    logger.info('[cron] loyaltyCandidateDetection: run complete.', summary);
    return summary;
  } catch (err) {
    logger.error('[cron] loyaltyCandidateDetection: job failed:', err.message);
    captureException(err);
    await recordHeartbeat('error', err.message, startedAt);
    return summary;
  }
}

function startLoyaltyCandidateDetectionJob() {
  // Weekly, Monday 06:00 - after the hourly expiry sweep exists and
  // well clear of the 00:0x nightly billing/qualification jobs, so it
  // reads a settled day's data rather than racing midnight jobs.
  cron.schedule('0 6 * * 1', async () => {
    await runLoyaltyCandidateDetection();
  });
  logger.info('[cron] Loyalty candidate detection scheduled (weekly, Mon 06:00).');
}

module.exports = {
  startLoyaltyCandidateDetectionJob,
  runLoyaltyCandidateDetection,
  filterNewCandidates,
  isAutoGrantEnabled,
  autoGrantMonthsThreshold,
  autoGrantPercentage,
};
