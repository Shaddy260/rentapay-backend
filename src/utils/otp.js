// src/utils/otp.js
//
// OTP generation for landlord/tenant verification (blueprint 3.1, 4.1, 14.2)
// and for password-reset codes (auth.controller.js).
//
// Two separate expiry windows, since they protect very different
// things and are handed out in very different contexts:
//   - VERIFICATION_OTP_EXPIRY_HOURS: covers first-time account
//     verification AND the temp password/OTP a brand-new
//     tenant/manager/caretaker/scout is given to log in for the very
//     first time. 24 hours - long enough to actually receive and act
//     on an SMS/email, short enough that a stale, unused invite isn't
//     sitting around valid for days.
//   - PASSWORD_RESET_OTP_EXPIRY_MINUTES: covers a "forgot password"
//     code. Much shorter (5 minutes) since this is a live,
//     time-sensitive security action the person is expected to be
//     actively doing right now, not something they'd reasonably come
//     back to a day later.

const VERIFICATION_OTP_EXPIRY_HOURS = 24;
const PASSWORD_RESET_OTP_EXPIRY_MINUTES = 5;

function generateOTP() {
  // 6-digit numeric code
  return String(Math.floor(100000 + Math.random() * 900000));
}

// First-time account verification / first-login credentials expiry
// (24 hours from now).
function getOTPExpiry() {
  const expiry = new Date();
  expiry.setHours(expiry.getHours() + VERIFICATION_OTP_EXPIRY_HOURS);
  return expiry;
}

// Password-reset code expiry (5 minutes from now) - deliberately
// separate from getOTPExpiry() above so the two windows can never
// drift into each other by accident.
function getPasswordResetOTPExpiry() {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + PASSWORD_RESET_OTP_EXPIRY_MINUTES);
  return expiry;
}

function isOTPExpired(expiresAt) {
  return new Date() > new Date(expiresAt);
}

module.exports = {
  generateOTP,
  getOTPExpiry,
  getPasswordResetOTPExpiry,
  isOTPExpired,
  VERIFICATION_OTP_EXPIRY_HOURS,
  PASSWORD_RESET_OTP_EXPIRY_MINUTES,
};
