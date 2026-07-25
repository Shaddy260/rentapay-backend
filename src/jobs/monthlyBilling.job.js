// src/jobs/monthlyBilling.job.js
//
// THE MISSING PIECE that caused balances to "not add up": nothing in
// the codebase ever added a new month's rent into balance_due when a
// billing cycle rolled over. tenant.controller.js's getBalance() used
// to paper over this by recomputing rentAmount + balance_due fresh on
// every request, which meant balance_due only ever represented
// "arrears carried from before" while the current month's rent was
// invented on the fly at display time - never actually added to the
// ledger, so a payment against it had nothing real to subtract from.
//
// This job is the single place balance_due increases. Everything else
// (payment.controller.js) only ever decreases it. Runs daily; for each
// active tenant whose due day has arrived and who hasn't already been
// billed for the current period, it adds one month's rent (+ any flat
// extra charges) to balance_due and stamps last_billed_period so the
// same tenant is never double-billed within one cycle.
//
// If a tenant is paid ahead (balance_due already negative/credit from
// a prior overpayment), the new rent charge is simply added on top -
// e.g. -4500 (one month credit) + 4500 (new month's rent) = 0, exactly
// cancelling out, which is the "credit gets used up automatically"
// behaviour requested.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { applyScheduledRentChanges } = require('../controllers/unit.controller');
const { runInBatches } = require('../utils/concurrency');

function currentPeriodKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function runMonthlyBilling() {
  console.log('[cron] Running monthly billing check...', new Date().toISOString());

  // Apply any rent changes scheduled for "next month" or a custom date
  // FIRST, so that if today is also this tenant's billing day, the
  // amount charged below already reflects the new rent rather than
  // lagging a day behind.
  await applyScheduledRentChanges();

  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('*, units(rent_amount, extra_charges, due_day_of_month)')
    .eq('is_active', true);

  if (error) {
    console.error('[cron] monthlyBilling: failed to fetch tenants:', error.message);
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const period = currentPeriodKey(today);

  // PERFORMANCE FIX: was a plain `for...of` awaiting one update at a
  // time - every tenant's billing update waited on the full round-trip
  // of the tenant before it, even though none of them depend on each
  // other. 10 at a time keeps this fast without opening an unbounded
  // number of simultaneous connections to Supabase.
  const dueTenants = (tenants || []).filter((tenant) => {
    const unit = tenant.units;
    if (!unit) return false;
    const dueDay = tenant.due_day_of_month || unit.due_day_of_month;
    if (!dueDay || today.getDate() < dueDay) return false; // billing day hasn't arrived yet this month
    if (tenant.last_billed_period === period) return false; // already billed this cycle
    return true;
  });

  await runInBatches(
    dueTenants,
    async (tenant) => {
      const unit = tenant.units;
      const rentAmount = Number(tenant.rent_override || unit.rent_amount || 0);
      const extrasTotal = (unit.extra_charges || []).reduce((sum, c) => sum + Number(c.amount || 0), 0);
      const charge = rentAmount + extrasTotal;

      const newBalance = Math.round((Number(tenant.balance_due || 0) + charge) * 100) / 100;

      const { error: updateError } = await supabase
        .from('tenants')
        .update({ balance_due: newBalance, last_billed_period: period })
        .eq('id', tenant.id);

      if (updateError) throw updateError;
    },
    {
      concurrency: 10,
      onError: (err, tenant) => console.error(`[cron] monthlyBilling: failed to bill tenant ${tenant.id}:`, err.message),
    }
  );

  console.log('[cron] Monthly billing check complete.');
}

// REMOVED (per landlord request: "remove the interest thing - there
// should be no interest on late payments"): this job used to add a
// daily late-payment penalty on top of any tenant's balance_due.
// Nothing calls it anymore; a tenant who's late now simply keeps
// owing exactly what they owed - flagged as overdue for follow-up,
// never charged extra for it. Kept here (commented) rather than
// deleted per project convention, in case interest is ever reinstated
// as an opt-in landlord setting later.
//
// async function runDailyInterestAccrual() { ... }

function startMonthlyBillingJob() {
  // THE FIX for "rent still shows 0 even though the tenant hasn't
  // paid this month": this job only used to run on the cron schedule
  // below (once daily, at 00:01). In development the server is
  // rarely left running across midnight, so it could go days without
  // ever actually firing - a freshly-added tenant's balance just sat
  // at 0 forever, with nothing to display in either portal. It's
  // idempotent (guarded by last_billed_period), so running it once
  // immediately here as well is always safe - it bills anyone who's
  // actually due and does nothing to anyone who isn't, whether that's
  // the first run after a fresh restart or the tenth run today.
  runMonthlyBilling();

  cron.schedule('1 0 * * *', async () => {
    await runMonthlyBilling();
  });
  console.log('[cron] Monthly billing job scheduled (daily at 00:01, plus once now on startup) - also applies any due scheduled rent changes. No interest accrual.');
}

module.exports = { startMonthlyBillingJob, runMonthlyBilling };
