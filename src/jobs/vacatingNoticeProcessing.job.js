// src/jobs/vacatingNoticeProcessing.job.js
//
// DIRECT REQUEST: "before that vacating date arrives, also remind the
// tenant several times - like twice - and tell them to revoke/call
// their [landlord] if they think it was a mistake, as when that same
// day arrives, after that their account should be deactivated. Right
// now it does not deactivate the account when the date arrives - check
// that."
//
// Confirmed: no existing job ever acted on tenants.notice_date at all
// - submitVacatingNotice (tenant.controller.js) only ever flips the
// UNIT to 'notice_given' and notifies the landlord; nothing was
// watching for the date to actually arrive. This job is the missing
// piece, run daily alongside the other reminder/billing jobs:
//
//   3 days before notice_date -> reminder #1
//   1 day before notice_date  -> reminder #2 (final warning)
//   on notice_date            -> deactivate (is_active = false),
//                                 unit flips notice_given -> vacant,
//                                 same soft-delete pattern deleteTenant
//                                 already uses so payment history and
//                                 the portable rating history are
//                                 preserved, not erased.
//
// Deactivation itself needs no new login-blocking logic: is_active is
// already the exact flag every login() lookup filters on (see
// auth.controller.js's `.eq('is_active', true)` on every non-landlord
// account type) - the same mechanism archived/removed tenants already
// go through. This job just needs to flip it at the right time.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const templates = require('../services/notificationTemplates');
const { notify } = require('../services/notify.service');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const { runInBatches } = require('../utils/concurrency');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const REMINDER_DAYS_BEFORE = [3, 1];

function daysUntil(dateStr, today) {
  const target = new Date(`${dateStr}T00:00:00`);
  const diffMs = target.getTime() - new Date(`${today}T00:00:00`).getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

async function runVacatingNoticeCheck() {
  logger.info('[cron] Running vacating-notice check...', new Date().toISOString());

  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, full_name, email, primary_phone, landlord_id, unit_id, notice_date, units(unit_name, property_id)')
    .eq('is_active', true)
    .eq('notice_given', true)
    .not('notice_date', 'is', null);

  if (error) {
    logger.error('[cron] vacatingNoticeProcessing: failed to fetch tenants:', error.message);
    captureException(error);
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  await runInBatches(
    tenants || [],
    async (tenant) => {
      const daysLeft = daysUntil(tenant.notice_date, todayStr);

      if (daysLeft <= 0) {
        // Vacate day has arrived (or already passed, e.g. the job
        // missed a run) - deactivate now. Same core steps as
        // deleteTenant's soft-delete (tenant.controller.js): is_active
        // = false + left_at stamped, unit freed up, tenant told.
        const { error: deactivateErr } = await supabase
          .from('tenants')
          .update({ is_active: false, left_at: new Date().toISOString() })
          .eq('id', tenant.id);
        if (deactivateErr) throw deactivateErr;

        const { data: unit } = await supabase.from('units').select('status').eq('id', tenant.unit_id).maybeSingle();
        if (unit && unit.status === 'notice_given') {
          await supabase.from('units').update({ status: 'vacant' }).eq('id', tenant.unit_id);
        }

        if (tenant.email) {
          try {
            await sendEmail(
              tenant.email,
              'Your RentaPay tenancy has ended',
              wrapEmailHtml(templates.vacatingDateArrivedAccountDeactivated(tenant.full_name, tenant.notice_date))
            );
          } catch (emailErr) {
            logger.error('[cron] vacatingNoticeProcessing: deactivation email failed:', emailErr.message);
            captureException(emailErr);
          }
        }

        await notify(
          'landlord',
          tenant.landlord_id,
          null,
          `${tenant.full_name} (Unit ${tenant.units?.unit_name || ''}) vacated today as scheduled - their account has been deactivated and the unit is now vacant.`,
          { category: 'account', title: 'Tenant vacated', propertyId: tenant.units?.property_id || null }
        );

        logActivity({
          actorType: 'system',
          actorId: null,
          action: 'tenant_vacating_date_reached_deactivated',
          targetType: 'tenant',
          targetId: tenant.id,
          metadata: { unitId: tenant.unit_id, noticeDate: tenant.notice_date },
        });
        return;
      }

      if (REMINDER_DAYS_BEFORE.includes(daysLeft)) {
        await notify(
          'tenant',
          tenant.id,
          tenant.primary_phone,
          templates.vacatingNoticeReminder(tenant.full_name, tenant.notice_date, daysLeft),
          { category: 'account', title: 'Vacating date coming up' }
        );
      }
    },
    {
      concurrency: 10,
      onError: (err, tenant) => {
        logger.error(`[cron] vacatingNoticeProcessing: failed for tenant ${tenant.id}:`, err.message);
        captureException(err);
      },
    }
  );

  logger.info('[cron] Vacating-notice check complete.');
}

function startVacatingNoticeJob() {
  // Runs once daily, same slot family as the other daily reminder
  // jobs (rent reminders run at 00:05, this at 00:06 to avoid piling
  // everything onto the exact same minute).
  cron.schedule('6 0 * * *', runVacatingNoticeCheck);
  logger.info('[cron] Vacating-notice job scheduled (daily at 00:06) - reminders + deactivation on the vacate date.');
}

module.exports = { startVacatingNoticeJob, runVacatingNoticeCheck };
