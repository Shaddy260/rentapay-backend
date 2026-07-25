// src/jobs/paymentConfirmationRetention.job.js
//
// Retention sweep for pending_payment_confirmations (manual Paybill
// payment confirmation flow - see payment.controller.js /
// pendingPaymentConfirmation.controller.js). Deletes 'confirmed' or
// 'rejected' rows once they're older than 6 months from their
// confirmed_or_rejected_at timestamp, unless the landlord/manager
// already deleted them sooner via DELETE
// /api/payments/pending-confirmations/:id.
//
// 'pending' rows are NEVER touched here regardless of age - an
// unresolved submission sitting for a long time is a landlord
// responsiveness problem, not something that should silently vanish.
//
// Mirrors the existing job pattern (node-cron, daily schedule, same
// console.log style) used in monthlyBilling.job.js / otpExpiry.job.js.

const cron = require('node-cron');
const supabase = require('../config/supabase');

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000; // matches the "6 months" wording used elsewhere in this codebase's retention logic

async function sweepOldPaymentConfirmations() {
  const cutoffIso = new Date(Date.now() - SIX_MONTHS_MS).toISOString();

  const { data: deletedRows, error } = await supabase
    .from('pending_payment_confirmations')
    .delete()
    .in('status', ['confirmed', 'rejected'])
    .lt('confirmed_or_rejected_at', cutoffIso)
    .select('id');

  if (error) {
    console.error('[cron] paymentConfirmationRetention: failed to sweep old records:', error.message);
    return;
  }

  console.log(`[cron] paymentConfirmationRetention: deleted ${deletedRows?.length || 0} confirmed/rejected payment confirmation(s) older than 6 months.`);
}

function startPaymentConfirmationRetentionJob() {
  // Once daily at 00:15 - same cadence as the other daily jobs in this
  // codebase, offset slightly so it doesn't collide with monthly
  // billing's own daily run.
  cron.schedule('15 0 * * *', sweepOldPaymentConfirmations);
  console.log('[cron] Payment confirmation retention sweep scheduled (daily).');
}

module.exports = { startPaymentConfirmationRetentionJob, sweepOldPaymentConfirmations };
