// src/jobs/notificationBatchFlush.job.js
//
// BUILD SPEC PHASE 20 - Notification Batching & Rate-Limiting.
//
// Runs every NOTIFICATION_BATCH_WINDOW_MINUTES (default 30, see
// notificationBatch.service.js) and delivers whatever is still sitting
// in notification_batch_queue as one combined message per recipient,
// per stream. A lone event never reaches this job at all - it's
// delivered immediately at queue time (see queueBatchedNotification)
// - so everything this job ever sees is, by definition, more than one
// event that landed close together for the same recipient.
//
// Two streams are flushed here, matching the two named in the spec:
//   - 'ba_alert'              - Phase 10 qualification/tier-crossed alerts to a BA
//   - 'admin_ba_report_ping'  - Phase 7 admin ping for in-app BA reports
//
// Neither flush ever touches qualification_status, payout_amount,
// commission_bonus_amount, current_commission_percent, or the BA
// report's own notifications-inbox row - all of that already happened
// at the point each event was queued (see baQualification.job.js and
// brandAmbassador.controller.js#shareClaimsReport). This job only
// decides when/how the *alert* goes out.
//
// Registers every run with system_heartbeats, same pattern as every
// other cron job in this app.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { flushBatchedNotifications, windowMinutes } = require('../services/notificationBatch.service');
const { notify } = require('../services/notify.service');
const { sendPushToRecipient } = require('../services/webpush.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const JOB_NAME = 'notification_batch_flush';

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
    logger.error('[cron] notificationBatchFlush: heartbeat write failed:', hbErr.message);
  }
}

// Builds the combined "3 of your landlords qualified, plus you
// crossed a new tier" style message for one BA out of however many
// 'qualified' / 'tier_crossed' events queued for them in this window.
function summarizeBaAlertEvents(events) {
  const qualifiedEvents = events.filter((e) => e.event_type === 'qualified');
  const tierEvents = events.filter((e) => e.event_type === 'tier_crossed');

  const totalQualified = qualifiedEvents.reduce((sum, e) => sum + (Number(e.metadata?.qualifiedCount) || 1), 0);
  const latestTier = tierEvents[tierEvents.length - 1] || null;

  const parts = [];
  if (totalQualified > 0) {
    parts.push(`${totalQualified} of your landlords qualified`);
  }
  if (latestTier) {
    const percent = latestTier.metadata?.percent;
    parts.push(percent != null ? `you crossed a new commission tier - now ${percent}%` : 'you crossed a new commission tier');
  }

  const body = parts.length > 0
    ? `${parts.join(', plus ')} - see your dashboard for details.`
    : 'You have new account updates - see your dashboard for details.';

  return { title: 'Account updates', body, urgent: !!latestTier };
}

async function runNotificationBatchFlush() {
  const startedAt = Date.now();
  try {
    const baResult = await flushBatchedNotifications('ba_alert', async (recipientType, recipientId, events) => {
      const { title, body, urgent } = summarizeBaAlertEvents(events);
      await notify(recipientType, recipientId, null, body, { category: 'account', title, urgent });
    });

    const adminResult = await flushBatchedNotifications('admin_ba_report_ping', async (recipientType, recipientId, events) => {
      // Ping only - every individual report's full content already
      // landed, intact and unmodified, in the admin inbox the moment
      // each BA sent it (shareClaimsReport). This grouped alert never
      // duplicates or replaces that content, it's purely the
      // notification-of-notifications the spec asks for.
      const names = [...new Set(events.map((e) => e.fragment).filter(Boolean))];
      const namesLabel = names.length > 5 ? `${names.slice(0, 5).join(', ')}, …` : names.join(', ');
      const body = events.length === 1
        ? `New BA report from ${names[0] || 'a Brand Ambassador'} - check your inbox.`
        : `${events.length} new BA reports (${namesLabel}) - check your inbox.`;
      await sendPushToRecipient(recipientType, recipientId, {
        title: `${events.length} new BA report${events.length === 1 ? '' : 's'}`,
        body,
      });
    });

    await recordHeartbeat('ok', null, startedAt);
    logger.info('[cron] Notification batch flush complete.', { baAlert: baResult, adminBaReportPing: adminResult });
  } catch (err) {
    logger.error('[cron] notificationBatchFlush: job failed:', err.message);
    captureException(err);
    await recordHeartbeat('error', err.message, startedAt);
  }
}

function startNotificationBatchFlushJob() {
  const minutes = windowMinutes();
  // Every N minutes, wrapping cleanly to an hourly form once N hits 60
  // so a large configured window still produces a valid cron
  // expression (node-cron's minute field tops out at 59).
  const expr = minutes >= 60 ? `0 */${Math.max(1, Math.round(minutes / 60))} * * *` : `*/${minutes} * * * *`;
  cron.schedule(expr, runNotificationBatchFlush);
  logger.info(`[cron] Notification batch flush job scheduled (every ${minutes} minute(s)).`);
}

module.exports = { startNotificationBatchFlushJob, runNotificationBatchFlush };
