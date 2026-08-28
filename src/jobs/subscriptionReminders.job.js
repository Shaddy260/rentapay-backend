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
//
// DIRECT REQUEST (grace period): "currently everything goes blank the
// moment the subscription expires... give him a grace period of 4
// days to continue using the platform... during the 4 days send one
// email telling him to renew... when it completely expires the 4
// days, then the public listings... are also removed until he
// subscribes again." The instant hard-cutover this job used to do the
// moment daysLeft hit 0 is now a two-step transition:
//
//   daysLeft ==  0  -> status flips 'active'/'warning' => 'grace'.
//                      Nothing is blocked yet (subscriptionGate.js
//                      only ever blocks on 'expired', so 'grace'
//                      passes straight through) and public listings
//                      stay up (isLandlordEligibleForPublicListing
//                      treats 'grace' as eligible). Exactly ONE email
//                      is sent here, at the moment of the transition
//                      into 'grace' - not resent on subsequent days.
//   daysLeft <= -4  -> status flips 'grace' => 'expired', the actual
//                      cutoff: subscriptionGate.js starts blocking
//                      and the landlord's units drop out of public
//                      listings (isLandlordEligibleForPublicListing
//                      no longer treats 'expired' as eligible). This
//                      reuses the same final-expiry email/push copy
//                      that used to fire at daysLeft <= 0.
//
// The 4 days of grace are counted off subscription_expires_at itself
// (daysLeft going from 0 to -4) rather than a separate "grace started
// at" column/timestamp - one less piece of state to keep in sync, and
// it self-corrects if this job is ever late/skipped a day.

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
    .in('subscription_status', ['active', 'warning', 'grace']);

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

      // Grace period is over (4 full days past expiry) - this is the
      // actual cutoff. Blocks the dashboard (subscriptionGate.js) and
      // pulls the landlord's units off public listings
      // (isLandlordEligibleForPublicListing), same as the old
      // immediate daysLeft<=0 cutover used to.
      if (daysLeft <= -4 && landlord.subscription_status === 'grace') {
        await supabase.from('landlords').update({ subscription_status: 'expired' }).eq('id', landlord.id);
        if (landlord.email) {
          await sendEmail(
            landlord.email,
            'Your RentaPay subscription has expired',
            wrapEmailHtml('Your 4-day grace period has ended and your RentaPay subscription has now fully expired. Log in and renew any time - your account and data are safe, but new payments are paused and any public listings you had are now hidden until you renew.')
          );
        }
        try {
          await notify(
            'landlord',
            landlord.id,
            landlord.phone,
            "Your 4-day grace period has ended and your RentaPay subscription has now fully expired. Log in and renew any time - your account and data are safe, but new payments are paused and any public listings you had are now hidden until you renew. Need help? Contact customer support.",
            { category: 'account', title: 'Subscription Expired', allowEmail: false, urgent: true }
          );
        } catch (notifyErr) {
          logger.warn(`[cron] Expiry push/in-app notice failed for landlord ${landlord.id} (non-fatal):`, notifyErr.message);
          captureException(notifyErr);
        }
        await logActivity({ actorType: 'system', action: 'subscription_auto_expired', targetType: 'landlord', targetId: landlord.id });
        return;
      }

      // Subscription just lapsed - start the 4-day grace period
      // instead of cutting access immediately. Access stays fully
      // open (subscriptionGate.js doesn't block 'grace') and public
      // listings stay up; this is the one and only email sent about
      // the grace period, right at the moment it starts.
      if (daysLeft <= 0 && landlord.subscription_status !== 'grace') {
        await supabase.from('landlords').update({ subscription_status: 'grace' }).eq('id', landlord.id);
        if (landlord.email) {
          await sendEmail(
            landlord.email,
            'Renew within 4 days to keep full access to RentaPay',
            wrapEmailHtml("Your RentaPay subscription has expired, but you've got a 4-day grace period to keep using the platform fully while you renew. Renew now to avoid any interruption - after the 4 days, access will be locked and any public listings you have will be hidden until you subscribe again.")
          );
        }
        try {
          await notify(
            'landlord',
            landlord.id,
            landlord.phone,
            "Your RentaPay subscription has expired. You have 4 days of grace to keep full access - renew now to avoid any interruption. After the grace period, access will be locked and your public listings hidden until you subscribe again.",
            { category: 'account', title: 'Renew within 4 days', allowEmail: false, urgent: true }
          );
        } catch (notifyErr) {
          logger.warn(`[cron] Grace-period push/in-app notice failed for landlord ${landlord.id} (non-fatal):`, notifyErr.message);
          captureException(notifyErr);
        }
        await logActivity({ actorType: 'system', action: 'subscription_grace_started', targetType: 'landlord', targetId: landlord.id });
        return;
      }

      // Already in grace but not yet past the 4-day cutoff - nothing
      // more to do today. The one grace-period email above already
      // went out; don't resend it daily.
      if (landlord.subscription_status === 'grace') return;

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
