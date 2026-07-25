// src/jobs/subscriptionReminders.job.js
//
// Implements blueprint 9.4's renewal reminder schedule, run once daily:
//   30 days left -> Email
//   14 days left -> dashboard warning banner (handled client-side from status)
//   7 days left  -> daily email reminders start
//   3 days left  -> urgent notification
//   0 days       -> auto-suspend

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const templates = require('../services/notificationTemplates');
const { logActivity } = require('../services/activityLog.service');
const { runInBatches } = require('../utils/concurrency');

async function runDailyCheck() {
  console.log('[cron] Running subscription reminder check...', new Date().toISOString());

  const { data: activeLandlords, error } = await supabase
    .from('landlords')
    .select('id, full_name, phone, email, subscription_expires_at, subscription_status')
    .in('subscription_status', ['active', 'warning']);

  if (error) {
    console.error('[cron] Failed to fetch landlords:', error.message);
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
        await logActivity({ actorType: 'system', action: 'subscription_auto_expired', targetType: 'landlord', targetId: landlord.id });
        return;
      }

      if ([30, 14, 7, 3].includes(daysLeft) && landlord.email) {
        try {
          await sendEmail(
            landlord.email,
            'Your RentaPay subscription is expiring soon',
            wrapEmailHtml(templates.subscriptionExpiring(daysLeft))
          );
        } catch (emailErr) {
          // Without this catch, one landlord's email failure (e.g. an
          // unverified Resend sending domain) would throw out of this
          // worker and (via onError below) just get logged - it must
          // NOT stop the status-update work for this landlord or for
          // anyone else in the batch.
          console.warn(`[cron] Email reminder failed for landlord ${landlord.id} (non-fatal):`, emailErr.message);
        }
      }

      // Days 7 down to 1: daily email reminders per blueprint
      if (daysLeft <= 7 && daysLeft > 0 && landlord.email) {
        await sendEmail(
          landlord.email,
          'Your RentaPay subscription is expiring soon',
          wrapEmailHtml(templates.subscriptionExpiring(daysLeft))
        );
      }

      if (daysLeft <= 14 && landlord.subscription_status !== 'warning') {
        await supabase.from('landlords').update({ subscription_status: 'warning' }).eq('id', landlord.id);
      }
    },
    {
      concurrency: 10,
      onError: (err, landlord) => console.error(`[cron] subscriptionReminders: failed for landlord ${landlord.id}:`, err.message),
    }
  );

  console.log('[cron] Subscription reminder check complete.');
}

function startSubscriptionReminderJob() {
  // Runs every day at 00:00 (midnight) server time
  cron.schedule('0 0 * * *', runDailyCheck);
  console.log('[cron] Subscription reminder job scheduled (daily at midnight).');
}

module.exports = { startSubscriptionReminderJob, runDailyCheck };
