// src/jobs/baStaleApplicationReminder.job.js
//
// BUILD SPEC PHASE 2 - "Admin gets reminded about applications sitting
// too long." Runs hourly and finds brand_ambassadors rows with
// status = 'pending_approval' where created_at is more than 12 hours
// ago AND (reminder_sent_at is null OR reminder_sent_at is more than
// 24 hours ago) - an initial nudge at the 12-hour mark, then roughly
// once a day after that until admin actions it, never a fresh
// notification every run.
//
// Registers every run (success or failure) with system_heartbeats -
// see sql/add-system-heartbeats.sql - so a silent failure here is
// discoverable the same way a silent billing-job failure would be,
// not found weeks later when a good applicant has been sitting
// unreviewed the whole time.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { sendEmail, wrapEmailHtml, SUPPORT_EMAIL } = require('../services/email.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const JOB_NAME = 'ba_stale_application_reminder';
const STALE_AFTER_HOURS = 12;
const RENOTIFY_AFTER_HOURS = 24;

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
    // Heartbeat itself failing is logged but never allowed to mask
    // the job's own real success/failure.
    logger.error('[cron] baStaleApplicationReminder: heartbeat write failed:', hbErr.message);
  }
}

async function sendStaleBaApplicationReminders() {
  const startedAt = Date.now();
  try {
    const staleCutoff = new Date(Date.now() - STALE_AFTER_HOURS * 60 * 60 * 1000).toISOString();
    const renotifyCutoff = new Date(Date.now() - RENOTIFY_AFTER_HOURS * 60 * 60 * 1000).toISOString();

    const { data: due, error } = await supabase
      .from('brand_ambassadors')
      .select('id, full_name, email, phone, created_at, reminder_sent_at')
      .eq('status', 'pending_approval')
      .lte('created_at', staleCutoff)
      .or(`reminder_sent_at.is.null,reminder_sent_at.lte.${renotifyCutoff}`)
      .limit(200);

    if (error) throw error;

    if (!due || due.length === 0) {
      await recordHeartbeat('ok', null, startedAt);
      return;
    }

    if (SUPPORT_EMAIL) {
      try {
        const rows = due
          .map((a) => `- ${a.full_name} (${a.phone}, ${a.email}) - waiting since ${new Date(a.created_at).toLocaleString()}`)
          .join('\n');
        await sendEmail(
          SUPPORT_EMAIL,
          `${due.length} Brand Ambassador application${due.length > 1 ? 's' : ''} waiting for review`,
          wrapEmailHtml(
            `The following Brand Ambassador application${due.length > 1 ? 's have' : ' has'} been pending for over ${STALE_AFTER_HOURS} hours:\n\n${rows}\n\nReview them in the admin portal under Brand Ambassador Applications.`
          )
        );
      } catch (emailErr) {
        logger.error('[cron] baStaleApplicationReminder: admin notify email failed:', emailErr.message);
        captureException(emailErr);
      }
    }

    const ids = due.map((a) => a.id);
    await supabase.from('brand_ambassadors').update({ reminder_sent_at: new Date().toISOString() }).in('id', ids);

    await recordHeartbeat('ok', null, startedAt);
  } catch (err) {
    logger.error('[cron] baStaleApplicationReminder: job failed:', err.message);
    captureException(err);
    await recordHeartbeat('error', err.message, startedAt);
  }
}

function startBaStaleApplicationReminderJob() {
  // Hourly, on the hour - "at least hourly" per spec.
  cron.schedule('0 * * * *', sendStaleBaApplicationReminders);
  logger.info('[cron] BA stale-application reminder job scheduled (hourly).');
}

module.exports = { startBaStaleApplicationReminderJob, sendStaleBaApplicationReminders };
