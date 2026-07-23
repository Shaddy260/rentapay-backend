// src/services/sentry.service.js
//
// HARDENING (2D - error tracking, Sentry free tier). Same "fail safe,
// log and continue" philosophy already used for WhatsApp/email in
// this codebase (see notify.service.js): a missing/invalid
// SENTRY_DSN, or @sentry/node simply not being installed yet, must
// never crash the app or block startup - it just means errors aren't
// being reported anywhere but the console, same as today.
//
// Requires adding "@sentry/node" to package.json's dependencies and
// running `npm install` before SENTRY_DSN actually does anything -
// see the summary note for the exact line to add. Until then this is
// a complete, harmless no-op.

let sentryClient = null;

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[sentry] SENTRY_DSN not set - error tracking disabled (this is fine in dev).');
    return;
  }

  try {
    // eslint-disable-next-line global-require
    const Sentry = require('@sentry/node');
    Sentry.init({ dsn, environment: process.env.NODE_ENV || 'development', tracesSampleRate: 0.1 });
    sentryClient = Sentry;
    console.log('[sentry] Error tracking initialized.');
  } catch (err) {
    // Covers both "@sentry/node isn't installed yet" (MODULE_NOT_FOUND)
    // and any unexpected init failure - either way, log and continue
    // exactly like every other optional integration in this codebase.
    console.warn('[sentry] Failed to initialize (continuing without error tracking):', err.message);
    sentryClient = null;
  }
}

/**
 * Safe capture - no-ops if Sentry was never initialized. Call this
 * from the centralized error handler and any catch block where you'd
 * like an error surfaced beyond the console, without ever risking a
 * throw of its own.
 */
function captureException(err) {
  if (!sentryClient) return;
  try {
    sentryClient.captureException(err);
  } catch (captureErr) {
    console.warn('[sentry] captureException failed (non-blocking):', captureErr.message);
  }
}

module.exports = { initSentry, captureException };
