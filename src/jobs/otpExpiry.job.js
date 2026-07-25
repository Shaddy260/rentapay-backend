// src/jobs/otpExpiry.job.js
//
// Direct request: every OTP / temp password stored anywhere on the
// platform - the first_time_credentials table, the new
// password_reset_requests table, AND the live otp_code/otp_expires_at
// columns on landlords/tenants/property_managers themselves - should
// expire and be DELETED the instant their expiry time is reached, not
// just be treated as invalid while the row/value still sits there.
//
// Runs every minute (rather than daily like the other jobs) so
// "immediately" is actually true in practice - nothing here is
// expensive since it's just deleting/nulling already-expired rows.

const cron = require('node-cron');
const supabase = require('../config/supabase');

async function sweepExpiredOtps() {
  const nowIso = new Date().toISOString();

  // 1) First-time login credentials (temp password + OTP handed out
  //    at account creation) - one shared table, all roles at once.
  const { error: firstTimeErr } = await supabase.from('first_time_credentials').delete().lt('expires_at', nowIso);
  if (firstTimeErr) console.error('[cron] otpExpiry: failed clearing expired first_time_credentials:', firstTimeErr.message);

  // 2) Password-reset OTP log (admin/landlord portal recovery view).
  const { error: resetLogErr } = await supabase.from('password_reset_requests').delete().lt('expires_at', nowIso);
  if (resetLogErr) console.error('[cron] otpExpiry: failed clearing expired password_reset_requests:', resetLogErr.message);

  // 3) The actual live otp_code/otp_expires_at columns used to verify
  //    a code at login/reset time - wipe them once expired so an
  //    expired code can never be reused/guessed, on every account
  //    table that carries these two columns.
  for (const table of ['landlords', 'tenants', 'property_managers']) {
    const { error } = await supabase
      .from(table)
      .update({ otp_code: null, otp_expires_at: null })
      .lt('otp_expires_at', nowIso)
      .not('otp_expires_at', 'is', null);
    if (error) console.error(`[cron] otpExpiry: failed clearing expired otp columns on ${table}:`, error.message);
  }
}

function startOtpExpiryJob() {
  // Every minute - "expire immediately" per direct request, so this
  // stays close to real-time without hammering the database.
  cron.schedule('* * * * *', sweepExpiredOtps);
  console.log('[cron] OTP/temp-password expiry sweep scheduled (every minute).');
}

module.exports = { startOtpExpiryJob, sweepExpiredOtps };
