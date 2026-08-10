// src/utils/maskPhone.js
//
// Mirrors the frontend's phone-masking helper. Kept server-side too
// because the BA payout qualification report persists the MASKED
// phone number directly in the database (see
// sql/2026-08-admin-help-settings-and-ba-payout-report.sql) - masking
// happens once, at generation time, not just cosmetically in the UI,
// since the report is meant to be downloaded and shared outside the
// app.
function maskPhoneMiddle(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (digits.length < 7) return phone || '';
  const visibleStart = Math.ceil((digits.length - 3) / 2);
  const start = digits.slice(0, visibleStart);
  const end = digits.slice(visibleStart + 3);
  return `${start}***${end}`;
}

module.exports = { maskPhoneMiddle };
