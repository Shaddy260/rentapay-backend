// src/jobs/subscriptionReminders.job.js
//
// DIRECT REQUEST: "the accounts with warning... those that are about
// to expire.. they should be sent push notifications reminding them
// of their subscription status... shift them from email to in app
// notifications and push notifications... shifting from email to in
// app notifications means we are going to remind them everyday" -
// the old 30/14/7/3-day (then daily 7-1) EMAIL schedule below is
// replaced with a single daily in-app inbox + push reminder for as
// long as the account sits in the 'warning' window (<=14 days left),
// so admin no longer has to chase expiring accounts by hand. The
// actual auto-expiry transition still keeps its email too - that's a
// one-time account-status change, not a repeating reminder - but it
// now also fires the same push/in-app so it's never email-only.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const { notify } = require('../services/notify.service');
const { logActivity } = require('../services/activityLog.service');
const { runInBatches } = require('../utils/concurrency');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

async function runDailyCheck() {
  logger.info('[cron] Running subscription reminder check...', new Date().toISOString());

  const { data: activeLandlords, error } = await supabase
    .from('landlords')
    .select('id, full_name, phone, email, subscription_expires_at, subscription_status')
    .in('subscription_status', ['active', 'warning']);

  if (error) {
    logger.error('[cron] Failed to fetch landlords:', error.message);
    captureException(error);
    return;
  }

  const now = new Date();

  // PERFORMANCE FIX: was a plain `for...of` awaiting each landlord's
  // DB update + SMS + email one at a time. Same fix as the other two
  // cron jobs - bounded concurrency instead of fully serial.
  await runInBatches(
    activeLandlords || [],
    async (landlord) => {
      if (!landlord.subscription_expires_at) return;

      const diffMs = new Date(landlord.subscription_expires_at).getTime() - now.getTime();
      const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      if (daysLeft <= 0) {
        await supabase.from('landlords').update({ subscription_status: 'expired' }).eq('id', landlord.id);
        if (landlord.email) {
          await sendEmail(
            landlord.email,
            'Your RentaPay subscription has expired',
            wrapEmailHtml('Your RentaPay subscription has expired. Log in and renew any time - your account and data are safe, but new payments are paused until you renew.')
          );
        }
        try {
          await notify(
            'landlord',
            landlord.id,
            landlord.phone,
            "Your RentaPay subscription has expired. Log in and renew any time - your account and data are safe, but new payments are paused until you renew. Need help? Contact customer support.",
            { category: 'account', title: 'Subscription Expired', allowEmail: false, urgent: true }
          );
        } catch (notifyErr) {
          logger.warn(`[cron] Expiry push/in-app notice failed for landlord ${landlord.id} (non-fatal):`, notifyErr.message);
          captureException(notifyErr);
        }
        await logActivity({ actorType: 'system', action: 'subscription_auto_expired', targetType: 'landlord', targetId: landlord.id });
        return;
      }

      if (daysLeft <= 14 && landlord.subscription_status !== 'warning') {
        await supabase.from('landlords').update({ subscription_status: 'warning' }).eq('id', landlord.id);
      }

      // Daily push + in-app reminder for the whole warning window,
      // replacing the old milestone-only email schedule.
      if (daysLeft <= 14) {
        try {
          await notify(
            'landlord',
            landlord.id,
            landlord.phone,
            `Your RentaPay subscription expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Renew any time from your dashboard to avoid interruption. Need help? Contact customer support.`,
            { category: 'account', title: 'Subscription Expiring Soon', allowEmail: false, urgent: true }
          );
        } catch (notifyErr) {
          // A single landlord's push/in-app failure must not stop the
          // status-update work for this landlord or anyone else in
          // the batch.
          logger.warn(`[cron] Subscription reminder push/in-app failed for landlord ${landlord.id} (non-fatal):`, notifyErr.message);
          captureException(notifyErr);
        }
      }
    },
    {
      concurrency: 10,
      onError: (err, landlord) => { logger.error(`[cron] subscriptionReminders: failed for landlord ${landlord.id}:`, err.message); captureException(err); },
    }
  );

  logger.info('[cron] Subscription reminder check complete.');
}

function startSubscriptionReminderJob() {
  // Runs every day at 00:00 (midnight) server time
  cron.schedule('0 0 * * *', runDailyCheck);
  logger.info('[cron] Subscription reminder job scheduled (daily at midnight).');
}

module.exports = { startSubscriptionReminderJob, runDailyCheck };
