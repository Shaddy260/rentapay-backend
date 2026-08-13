// src/jobs/loyaltyDiscountExpiry.job.js
//
// P2 (loyalty-discount-roadmap.md): "Give a granted discount an
// expiry... A grant sits active indefinitely until used or revoked.
// No urgency, and the reminder popup has nothing to push toward."
//
// Every READ of "is this discount active" (getActiveDiscountForLandlord,
// getActiveDiscountRecordForLandlord, getReminderForLandlord,
// listActiveDiscounts, findConsecutiveLandlordCandidates - see
// landlordLoyalty.service.js) already treats an expired-but-still-
// is_active row as inactive on its own, so correctness never depends
// on this job having run recently. This job just keeps the underlying
// is_active flag itself honest for anything that reads it directly
// (e.g. admin history views, reporting) - same "belt and suspenders"
// relationship as otpExpiry.job.js has to its own read-time checks.
//
// Runs hourly - a lapsed discount doesn't need second-level precision.

const cron = require('node-cron');
const { expireLapsedLoyaltyDiscounts } = require('../services/landlordLoyalty.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

async function sweepExpiredLoyaltyDiscounts() {
  try {
    const expired = await expireLapsedLoyaltyDiscounts();
    if (expired.length > 0) {
      logger.info(`[cron] loyaltyDiscountExpiry: deactivated ${expired.length} lapsed, unused loyalty discount(s).`);
    }
  } catch (err) {
    logger.error('[cron] loyaltyDiscountExpiry: sweep failed:', err.message);
    captureException(err);
  }
}

function startLoyaltyDiscountExpiryJob() {
  cron.schedule('0 * * * *', sweepExpiredLoyaltyDiscounts); // every hour, on the hour
  logger.info('[cron] Loyalty discount expiry sweep scheduled (hourly).');
}

module.exports = { startLoyaltyDiscountExpiryJob, sweepExpiredLoyaltyDiscounts };
