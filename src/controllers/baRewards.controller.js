// src/controllers/baRewards.controller.js
//
// Premium Redesign Plan - Phase 8: Admin BA Performance & Rewards
// Dashboard.

const service = require('../services/baRewards.service');
const { generateBaRewardReportPdf } = require('../services/pdfReport.service');
const logger = require('../utils/logger');
const { captureException } = require('../services/sentry.service');
const { brandedFilename } = require('../services/csvBranding.service');

// GET /api/brand-ambassadors/rewards/leaderboard
async function getLeaderboard(req, res) {
  try {
    const leaderboard = await service.getLeaderboard();
    res.json({ leaderboard });
  } catch (err) {
    logger.error('[baRewards] getLeaderboard failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to load the leaderboard.' });
  }
}

// POST /api/brand-ambassadors/rewards
// body: { baIds: string[], newPercentage: number, startAt?: string, endAt: string }
async function reward(req, res) {
  try {
    const { baIds, newPercentage, startAt, endAt } = req.body || {};
    const result = await service.rewardBAs({
      baIds,
      newPercentage,
      startAt,
      endAt,
      adminId: req.user?.id,
    });
    res.json({
      batch: result.batch,
      rewards: result.rewards,
      // FIX (direct request: "he's supposed to be notified... it just
      // says he's notified but ... none is"): this used to hardcode
      // `done: true` for the "notified" line no matter what actually
      // happened - rewardBAs() now awaits the notify() calls and
      // reports back how many of the selected BAs actually received
      // something (in-app inbox row or push), so a real delivery
      // failure shows up here instead of a false "notified" claim.
      whatHappensNext: [
        { key: 'pdf', label: 'PDF report generated', done: true },
        {
          key: 'notified',
          label: result.notifiedCount === result.bas.length
            ? `${result.bas.length} rewarded Brand Ambassador${result.bas.length === 1 ? '' : 's'} notified`
            : `${result.notifiedCount} of ${result.bas.length} rewarded Brand Ambassador${result.bas.length === 1 ? '' : 's'} notified`,
          done: result.notifiedCount === result.bas.length,
        },
        { key: 'broadcast', label: 'Broadcast sent to the rest of the BA base', done: true },
      ],
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logger.error('[baRewards] reward failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to confirm the reward.' });
  }
}

// GET /api/brand-ambassadors/rewards/history
async function getHistory(req, res) {
  try {
    const history = await service.listRewardHistory();
    res.json({ history });
  } catch (err) {
    logger.error('[baRewards] getHistory failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to load the reward history.' });
  }
}

// GET /api/brand-ambassadors/rewards/:batchId/pdf
async function downloadRewardPdf(req, res) {
  try {
    const result = await service.getRewardBatch(req.params.batchId);
    if (!result) return res.status(404).json({ error: 'Reward batch not found.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${brandedFilename('ba-reward-report', result.batch.id.slice(0, 8), 'pdf')}"`);
    generateBaRewardReportPdf(res, { batch: result.batch, rewards: result.rewards, generatedAt: new Date() });
  } catch (err) {
    logger.error('[baRewards] downloadRewardPdf failed', err);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download the reward report.' });
  }
}

// POST /api/brand-ambassadors/rewards/challenge-broadcast
// Standing "challenge" style prompt, admin-triggered (also suitable to
// wire into a scheduled job later without any controller changes).
async function sendChallengeBroadcast(req, res) {
  try {
    const result = await service.sendStandingChallengeBroadcast();
    res.json(result);
  } catch (err) {
    logger.error('[baRewards] sendChallengeBroadcast failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to send the challenge broadcast.' });
  }
}

module.exports = { getLeaderboard, reward, getHistory, downloadRewardPdf, sendChallengeBroadcast };
