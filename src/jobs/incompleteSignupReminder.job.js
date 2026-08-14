// src/jobs/incompleteSignupReminder.job.js
//
// DIRECT REQUEST: "landlords who began setting up and have not
// completed yet, the system can send them automated push messages
// telling them to complete setup that they began... and if they need
// help they contact customer support" - so admin doesn't have to
// chase abandoned signups by hand.
//
// Reuses the exact same "incomplete signup" definition
// admin.controller.js's getIncompleteSignups already uses:
// setup_wizard_complete is still false, and the account hasn't been
// suspended. Runs once daily; gives a new signup a full day before
// the first nudge (so nobody gets pinged five minutes after
// registering), then reminds once every day after that for as long
// as the wizard stays unfinished - in-app inbox + push only, no
// email, consistent with the rest of the reminder jobs.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { notify } = require('../services/notify.service');
const { runInBatches } = require('../utils/concurrency');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const REMINDER_MESSAGE =
  "You started setting up your RentaPay account but haven't finished yet. " +
  'Log back in to pick up right where you left off. Need a hand? Contact customer support and we\'ll help you get set up.';

async function runIncompleteSignupCheck() {
  logger.info('[cron] Running incomplete signup reminder check...', new Date().toISOString());

  const { data: landlords, error } = await supabase
    .from('landlords')
    .select('id, full_name, phone, created_at')
    .eq('setup_wizard_complete', false)
    .neq('subscription_status', 'suspended');

  if (error) {
    logger.error('[cron] incompleteSignupReminder: failed to fetch landlords:', error.message);
    captureException(error);
    return;
  }

  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  const dueForReminder = (landlords || []).filter((l) => {
    if (!l.created_at) return false;
    // Give a brand-new signup a full day before the first nudge.
    return now - new Date(l.created_at).getTime() >= ONE_DAY_MS;
  });

  await runInBatches(
    dueForReminder,
    async (landlord) => {
      await notify('landlord', landlord.id, landlord.phone, REMINDER_MESSAGE, {
        category: 'account',
        title: 'Finish setting up your account',
        allowEmail: false,
        urgent: true,
      });
    },
    {
      concurrency: 10,
      onError: (err, landlord) => {
        logger.error(`[cron] incompleteSignupReminder: failed for landlord ${landlord.id}:`, err.message);
        captureException(err);
      },
    }
  );

  logger.info(`[cron] Incomplete signup reminder check complete. Reminded ${dueForReminder.length} landlord(s).`);
}

function startIncompleteSignupReminderJob() {
  // Runs once daily, offset from the other midnight jobs.
  cron.schedule('15 0 * * *', runIncompleteSignupCheck);
  logger.info('[cron] Incomplete signup reminder job scheduled (daily at 00:15).');
}

module.exports = { startIncompleteSignupReminderJob, runIncompleteSignupCheck };
