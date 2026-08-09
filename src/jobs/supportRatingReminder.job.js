// src/jobs/supportRatingReminder.job.js
//
// Section 9.2 of the AI Support Chat spec: RentaPay can't detect in
// real time when a phone call (triggered via the tel: link) actually
// ends, since it happens outside the app in the native dialer. This is
// the backup trigger - a push notification ~12 minutes after every
// "Talk to an agent" handoff, asking how the call went. If the user
// already rated via the in-app-return prompt (Section 9.1) before this
// runs, the escalation's rated_at is already set and it's skipped -
// same reasoning as cancelling a pending notification, just via a
// "already rated?" check instead of an actual cancel call.
//
// Runs every minute so the 10-15 minute window from the spec is honored
// closely without a heavier scheduling system.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { sendPushToRecipient } = require('../services/webpush.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const REMINDER_DELAY_MS = 12 * 60 * 1000; // 12 minutes after the call handoff

async function sendPendingRatingReminders() {
  const cutoff = new Date(Date.now() - REMINDER_DELAY_MS).toISOString();

  const { data: due, error } = await supabase
    .from('support_escalations')
    .select('id, user_type, user_id')
    .is('rated_at', null)
    .is('reminder_push_sent_at', null)
    .lte('created_at', cutoff)
    .limit(50);

  if (error) {
    logger.error('[cron] supportRatingReminder: failed to fetch due escalations:', error.message);
    captureException(error);
    return;
  }
  if (!due || due.length === 0) return;

  for (const escalation of due) {
    try {
      await sendPushToRecipient(escalation.user_type, escalation.user_id, {
        title: 'How did your call go?',
        body: 'How did your recent call with RentaPay support go? Tap to rate.',
      });
    } catch (err) {
      logger.error(`[cron] supportRatingReminder: push failed for escalation ${escalation.id}:`, err.message);
    } finally {
      // Mark as sent regardless of push success - a failed/unsupported
      // push shouldn't retry forever; the in-app 9.1 trigger still
      // catches the person on their next app open either way.
      await supabase.from('support_escalations').update({ reminder_push_sent_at: new Date().toISOString() }).eq('id', escalation.id);
    }
  }
}

function startSupportRatingReminderJob() {
  cron.schedule('* * * * *', sendPendingRatingReminders);
  logger.info('[cron] Support call rating-reminder job scheduled (every minute, ~12min delay).');
}

module.exports = { startSupportRatingReminderJob, sendPendingRatingReminders };
