// src/controllers/baPayoutLinkCycle.controller.js
//
// BA Monthly Payment Details & Payout Workflow.
//
// ADMIN GET /api/brand-ambassadors/payout-link/current - current
// month's cycle status, used purely to group ba_commission_earnings by
// calendar period for the Pending/Completed/History views. Creates the
// cycle lazily on first call of a new month (see the cycle service).
//
// BUILD SPEC PHASE 10 (v2): link validation for the universal
// submission link (no token to validate - it's a static URL) and the
// universal 24h edit link now live in baPaymentSubmission.controller.js
// alongside the rest of that flow.

const { getOrCreateCurrentCycle } = require('../services/baPayoutLinkCycle.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------
// ADMIN - current cycle status: period_key, status. Always returns a
// cycle (creates it if this is the first time anyone's looked this
// month).
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
      },
    });
  } catch (err) {
    logger.error('[baPayoutLinkCycle] getCurrentCycleStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the payout link status.' });
  }
}

module.exports = {
  getCurrentCycleStatus,
};
