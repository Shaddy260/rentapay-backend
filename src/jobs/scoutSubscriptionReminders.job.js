// src/jobs/scoutSubscriptionReminders.job.js
//
// Same reminder cadence and "grace, don't hard-cut" philosophy as
// subscriptionReminders.job.js, scoped to scout_county_subscriptions
// expiry instead of landlord subscription expiry. Runs once daily.
// Unlike a landlord (one account-level subscription_status), a Scout
// can have several counties at different points in their own expiry
// cycle - each row is checked and reminded independently, and only
// THAT county stops returning vacancy results (Phase 5) when it
// lapses, not the whole account.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const { sendPushToRecipient } = require('../services/webpush.service');
const { logActivity } = require('../services/activityLog.service');
const { runInBatches } = require('../utils/concurrency');

async function runDailyCheck() {
  console.log('[cron] Running Scout county-subscription reminder check...', new Date().toISOString());

  const { data: activeSubs, error } = await supabase
    .from('scout_county_subscriptions')
    .select('id, scout_id, county, expires_at, status, scouts(full_name, email)')
    .eq('status', 'active');

  if (error) {
    console.error('[cron] Failed to fetch scout_county_subscriptions:', error.message);
    return;
  }

  const now = new Date();

  await runInBatches(
    activeSubs || [],
    async (sub) => {
      if (!sub.expires_at) return;

      const diffMs = new Date(sub.expires_at).getTime() - now.getTime();
      const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      const email = sub.scouts?.email;

      if (daysLeft <= 0) {
        // "Grace, don't hard-cut": exactly the same posture as the
        // landlord job - the row is marked expired (which Phase 5's
        // server-side county check reads directly), the Scout keeps
        // their account and every OTHER county's subscription intact,
        // and a renewal is one payment away, no re-registration.
        await supabase.from('scout_county_subscriptions').update({ status: 'expired' }).eq('id', sub.id);
        if (email) {
          await sendEmail(
            email,
            `Your RentaPay Scout subscription for ${sub.county} has expired`,
            wrapEmailHtml(`Your RentaPay Scout subscription for ${sub.county} has expired. Renew any time from the app to keep browsing vacancies there.`)
          );
        }
        await sendPushToRecipient('scout', sub.scout_id, {
          title: 'Subscription expired',
          body: `Your Scout subscription for ${sub.county} has expired. Renew from the app to keep browsing vacancies there.`,
          url: '/scout',
        });
        await logActivity({ actorType: 'system', action: 'scout_county_subscription_auto_expired', targetType: 'scout', targetId: sub.scout_id, metadata: { county: sub.county } });
        return;
      }

      if ([30, 14, 7, 3].includes(daysLeft) && email) {
        await sendEmail(
          email,
          `Your RentaPay Scout subscription for ${sub.county} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          wrapEmailHtml(`Your RentaPay Scout subscription for ${sub.county} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Renew from the app to keep browsing vacancies there without interruption.`)
        );
      }

      if ([30, 14, 7, 3].includes(daysLeft)) {
        await sendPushToRecipient('scout', sub.scout_id, {
          title: 'Subscription expiring soon',
          body: `Your Scout subscription for ${sub.county} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
          url: '/scout',
        });
      }

      if (daysLeft <= 7 && daysLeft > 0 && email) {
        await sendEmail(
          email,
          `Reminder: your RentaPay Scout subscription for ${sub.county} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          wrapEmailHtml(`Reminder: your RentaPay Scout subscription for ${sub.county} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`)
        );
      }
    },
    {
      concurrency: 10,
      onError: (err, sub) => console.error(`[cron] scoutSubscriptionReminders: failed for scout ${sub.scout_id}/${sub.county}:`, err.message),
    }
  );

  console.log('[cron] Scout county-subscription reminder check complete.');
}

function startScoutSubscriptionReminderJob() {
  // Runs every day at 00:15 (midnight-fifteen) - deliberately offset
  // 15 minutes from the landlord job so both daily sweeps don't hit
  // Supabase and the SMS provider at the exact same instant.
  cron.schedule('15 0 * * *', runDailyCheck);
  console.log('[cron] Scout county-subscription reminder job scheduled (daily at 00:15).');
}

module.exports = { startScoutSubscriptionReminderJob, runDailyCheck };
