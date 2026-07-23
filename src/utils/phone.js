// src/utils/phone.js
//
// THE ROOT CAUSE behind several reported bugs ("no matching account",
// "invalid code" on forgot-password, tenants who can't log in with the
// number their landlord typed for them): phone numbers were NEVER
// normalized anywhere in this codebase. A landlord typing a tenant's
// number as "0712345678" got stored exactly like that. If that same
// tenant later typed "254712345678" (or "+254712345678") anywhere -
// login, forgot password, OTP resend - every lookup did an EXACT
// string match against the stored value and found nothing.
//
// This function converts any of the common Kenyan phone formats into
// one canonical shape: "2547XXXXXXXX" / "2541XXXXXXXX" (12 digits,
// no '+', no leading 0). Every place that stores or looks up a phone
// number - registerLandlord, addTenant, login, resendOTP,
// requestPasswordReset, resetPassword, editTenantDetails - must run
// the value through this first, both on write AND on read/lookup.
//
// Accepted inputs (whitespace/dashes are stripped first):
//   0712345678      -> 254712345678
//   0112345678      -> 254112345678   (Airtel/Telkom-style 011 numbers)
//   712345678       -> 254712345678   (missing leading 0)
//   112345678       -> 254112345678
//   +254712345678   -> 254712345678
//   254712345678    -> 254712345678   (already correct - passthrough)

function normalizePhone(raw) {
  if (raw == null) return null;
  let digits = String(raw).trim().replace(/[\s\-()]/g, '');

  if (digits.startsWith('+')) digits = digits.slice(1);

  if (digits.startsWith('254')) {
    digits = digits.slice(3);
  } else if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  // else: assume it's already the 9-digit local part (no 0, no 254)

  // A valid Kenyan mobile local part is 9 digits starting with 7 or 1.
  if (!/^[17]\d{8}$/.test(digits)) {
    return null; // not a recognizable Kenyan number - let the caller validate/reject
  }

  return `254${digits}`;
}

/**
 * Same as normalizePhone but throws a clear error instead of returning
 * null, for call sites where an unrecognizable number should hard-fail
 * validation rather than silently proceed with a bad value.
 */
function normalizePhoneOrThrow(raw, fieldLabel = 'Phone number') {
  const normalized = normalizePhone(raw);
  if (!normalized) {
    throw new Error(`${fieldLabel} "${raw}" doesn't look like a valid Kenyan number (e.g. 07XXXXXXXX or 2547XXXXXXXX).`);
  }
  return normalized;
}

module.exports = { normalizePhone, normalizePhoneOrThrow };
