// src/utils/resendRateLimit.js
//
// FEATURE (direct request: "in every activity where a user asks a
// code to be resend...either during verification, password reset or
// anything requiring email...a user can only consecutively ask the
// code to be resend 3 times...after the 3 times and still taps
// resend...give an error for too many attempts and ask them to try
// again after 1hr"): one shared limiter, keyed per (flow, identifier)
// so a verification-code spam attempt on one account doesn't affect
// that same person's password-reset attempts and vice versa.
//
// In-memory, matching the existing subscriptionExpiredCache/lockdown
// pattern already used elsewhere in this codebase - fine for a single
// backend instance. If RentaPay ever runs multiple backend instances
// behind a load balancer, this should move to a shared store (Redis,
// or a Supabase table) so the count is consistent across instances.
const MAX_CONSECUTIVE_RESENDS = 3;
const LOCKOUT_MS = 60 * 60 * 1000; // 1 hour

const attempts = new Map(); // key -> { count, blockedUntil }

function keyFor(flow, identifier) {
  return `${flow}:${String(identifier || '').trim().toLowerCase()}`;
}

/**
 * Call BEFORE sending a resend. Returns { allowed: true } to proceed,
 * or { allowed: false, retryAfterMinutes } if the 4th+ consecutive
 * attempt has just been blocked (or an earlier block is still active).
 */
function checkAndRecordResend(flow, identifier) {
  const key = keyFor(flow, identifier);
  const now = Date.now();
  let entry = attempts.get(key);

  if (entry?.blockedUntil && now < entry.blockedUntil) {
    return { allowed: false, retryAfterMinutes: Math.ceil((entry.blockedUntil - now) / 60000) };
  }

  if (entry?.blockedUntil && now >= entry.blockedUntil) {
    // Cooldown has passed - start counting fresh.
    entry = null;
  }

  const count = (entry?.count || 0) + 1;

  if (count > MAX_CONSECUTIVE_RESENDS) {
    attempts.set(key, { count, blockedUntil: now + LOCKOUT_MS });
    return { allowed: false, retryAfterMinutes: 60 };
  }

  attempts.set(key, { count, blockedUntil: null });
  return { allowed: true };
}

/**
 * Call after a genuinely successful, unrelated action tied to the
 * same identifier (e.g. the code was verified successfully) to clear
 * the consecutive-resend count early rather than waiting out the
 * window unnecessarily.
 */
function clearResendAttempts(flow, identifier) {
  attempts.delete(keyFor(flow, identifier));
}

module.exports = { checkAndRecordResend, clearResendAttempts };
