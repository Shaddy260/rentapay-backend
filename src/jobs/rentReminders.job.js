// src/jobs/rentReminders.job.js
//
// Implements blueprint 10.1's tenant reminder schedule:
//   3 days before due -> friendly reminder
//   on due date        -> "pay today" reminder
//   1 day after due     -> overdue notice
//   every 3 days late   -> outstanding balance update
// No interest/late-fee is ever added (removed per direct request) -
// this only tracks days late for reminder cadence, not for billing.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const templates = require('../services/notificationTemplates');
const { daysOverdue } = require('../utils/overdue');
const { notify } = require('../services/notify.service');
const { buildPaymentInstructions } = require('../utils/paymentInstructions');
const { runInBatches } = require('../utils/concurrency');

async function runDailyRentCheck() {
  console.log('[cron] Running rent reminder check...', new Date().toISOString());

  const { data: tenants, error } = await supabase
    .from('tenants')
    .select(
      '*, units(unit_name, rent_amount, due_day_of_month, property_id, payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, properties(payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number)), landlords(phone, payment_method, paybill_number, paybill_account_number, till_number)'
    )
    .eq('is_active', true);

  if (error) {
    console.error('[cron] Failed to fetch tenants:', error.message);
    return;
  }

  const today = new Date();

  // PERFORMANCE FIX: was a plain `for...of` awaiting each tenant's
  // SMS/push notify() calls one at a time - with real notification
  // network latency per call, a platform-wide reminder run could take
  // minutes. 10 at a time keeps this fast without hammering the SMS
  // provider past its own rate limits, and one tenant's send failure
  // (network blip, bad phone number) can no longer stop the rest of
  // the run.
  //
  // BUG FIX: the move-in-date anniversary check used to be duplicated
  // verbatim, once near the top of the loop body and again at the
  // bottom - every tenant's anniversary fired the exact same landlord
  // notification TWICE. It now only runs once per tenant.
  await runInBatches(
    tenants || [],
    async (tenant) => {
      const unit = tenant.units;
      const dueDay = tenant.due_day_of_month || unit.due_day_of_month;
      const rentAmount = tenant.rent_override || unit.rent_amount;
      const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
      const payInfo = buildPaymentInstructions(tenant.landlords, unit);

      // Direct request: "renewal reminders - nothing currently flags
      // 'this tenant's been here a year, might be time to review the
      // rent.'" Fires to the landlord (never the tenant) once a year,
      // exactly on the move-in-date anniversary. Checked before the
      // balance_due skip below - tenure has nothing to do with whether
      // rent happens to be owed today, so a paid-up tenant's
      // anniversary must still fire.
      if (tenant.move_in_date && tenant.landlords) {
        const moveIn = new Date(tenant.move_in_date);
        const yearsIn = today.getFullYear() - moveIn.getFullYear();
        if (yearsIn >= 1 && today.getDate() === moveIn.getDate() && today.getMonth() === moveIn.getMonth()) {
          await notify(
            'landlord',
            tenant.landlord_id,
            tenant.landlords.phone,
            `${tenant.full_name} (${unit.unit_name}) has been a tenant for ${yearsIn} year${yearsIn === 1 ? '' : 's'} today - might be worth reviewing the rent or reaching out about renewal.`,
            { category: 'general', title: 'Tenant renewal reminder', propertyId: unit.property_id || null }
          );
        }
      }

      // FIX (direct request): "during the sending of reminders at
      // midnight it sends to all tenants including those that have a
      // negative balance [i.e. paid ahead]." Skip the entire reminder
      // cycle for this tenant when nothing is actually owed.
      if (Number(tenant.balance_due) <= 0) return;

      const diffDays = Math.round((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

      if (diffDays === 3) {
        const msg = `${templates.rentDueSoon(tenant.full_name, rentAmount, dueDate.toLocaleDateString('en-GB'))} ${payInfo.text}`;
        await notify('tenant', tenant.id, tenant.primary_phone, msg, { category: 'rent_reminder', title: 'Rent Due Soon' });
      } else if (diffDays === 0) {
        const msg = `${templates.rentDueToday(tenant.full_name, rentAmount)} ${payInfo.text}`;
        await notify('tenant', tenant.id, tenant.primary_phone, msg, { category: 'rent_reminder', title: 'Rent Due Today' });
      } else if (diffDays < 0) {
        const overdue = daysOverdue(dueDate, today);

        // No more interest - tenant.balance_due is the plain amount
        // owed, never inflated with a late-payment penalty.
        if (overdue === 1) {
          const msg = `${templates.rentOverdue(tenant.full_name, rentAmount)} ${payInfo.text}`;
          await notify('tenant', tenant.id, tenant.primary_phone, msg, { category: 'overdue', title: 'Rent Overdue' });
        } else if (overdue % 3 === 0) {
          const totalDue = Number(tenant.balance_due || 0);
          const msg = `${templates.overdueUpdate(tenant.full_name, totalDue.toFixed(2), overdue)} ${payInfo.text}`;
          await notify('tenant', tenant.id, tenant.primary_phone, msg, { category: 'overdue', title: 'Balance Update' });
        }

        // Landlord alerts at 3 and 7 days overdue (blueprint 10.2)
        if ([3, 7].includes(overdue) && tenant.landlords) {
          const totalDue = Number(tenant.balance_due || 0);
          await notify(
            'landlord',
            tenant.landlord_id,
            tenant.landlords.phone,
            templates.overdueAlert(tenant.full_name, unit.unit_name, overdue, totalDue.toFixed(2)),
            { category: 'overdue', title: 'Tenant Overdue Alert', propertyId: unit.property_id || null }
          );
        }
      }
    },
    {
      concurrency: 10,
      onError: (err, tenant) => console.error(`[cron] rentReminders: failed for tenant ${tenant.id}:`, err.message),
    }
  );

  console.log('[cron] Rent reminder check complete.');
}

function startRentReminderJob() {
  // Runs once daily, slightly after midnight to avoid clashing with subscription job
  cron.schedule('5 0 * * *', runDailyRentCheck);
  console.log('[cron] Rent reminder job scheduled (daily at 00:05).');
}

module.exports = { startRentReminderJob, runDailyRentCheck };
