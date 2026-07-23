// src/utils/email.js
//
// Small shared validator so every place that now requires an email
// address (landlord registration, tenant/manager/caretaker/scout
// onboarding - see the "email mandatory, OTPs go via email" direct
// request) checks it the same way instead of five slightly different
// regexes drifting apart over time.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

module.exports = { isValidEmail };
