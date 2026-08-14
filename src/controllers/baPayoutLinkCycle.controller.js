// src/controllers/baPayoutLinkCycle.controller.js
//
// BA Monthly Payment Details & Payout Workflow - Phase 1.
//
// Two endpoints only in this phase:
//   ADMIN  GET /api/brand-ambassadors/payout-link/current   - current
//          month's cycle status + the public submission link, so the
//          admin portal can show/copy/share it. Creates the cycle
//          lazily on first call of a new month (see the cycle service).
//   PUBLIC GET /api/brand-ambassadors/payout-link/validate  - the
//          Phase 2 submission page calls this on load with ?token= to
//          confirm the link is still good before rendering the form.
//
// The actual submission form (Phase 2) and admin Pending/Completed
// views (Phase 3/4) are separate, later phases - this controller only
// covers cycle lifecycle + link validation.

const {
  getOrCreateCurrentCycle,
  validateSubmissionToken,
  publicLinkForToken,
} = require('../services/baPayoutLinkCycle.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------
// ADMIN - current cycle status: period_key, status, and the public
// link to share. Always returns a cycle (creates it if this is the
// first time anyone's looked this month).
// ---------------------------------------------------------------------
async function getCurrentCycleStatus(req, res) {
  try {
    const cycle = await getOrCreateCurrentCycle(req.user?.id || null);
    return res.json({
      cycle: {
        id: cycle.id,
        periodKey: cycle.period_key,
        status: cycle.status,
        generatedAt: cycle.generated_at,
        link: publicLinkForToken(cycle.token),
      },
    });
  } catch (err) {
    logger.error('[baPayoutLinkCycle] getCurrentCycleStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the payout link status.' });
  }
}

// ---------------------------------------------------------------------
// PUBLIC - validate a ?token= before the submission form renders.
// ---------------------------------------------------------------------
async function validatePayoutLinkToken(req, res) {
  try {
    const { token } = req.query;
    const result = await validateSubmissionToken(token);
    if (!result.ok) {
      return res.status(410).json({ valid: false, error: result.error });
    }
    return res.json({ valid: true, periodKey: result.cycle.period_key });
  } catch (err) {
    logger.error('[baPayoutLinkCycle] validatePayoutLinkToken error:', err.message);
    captureException(err);
    return res.status(500).json({ valid: false, error: 'Failed to validate the payment details link.' });
  }
}

module.exports = {
  getCurrentCycleStatus,
  validatePayoutLinkToken,
};
