// src/controllers/subscriptionPricing.controller.js
//
// Admin endpoints for:
//  1. The subscription fee itself (base rate per unit/month + the
//     period-length discount tiers) - affects signup, adding a
//     property, adding units mid-period, and renewing/managing a
//     subscription, since all of those go through the single
//     calculateSubscriptionCost() helper (utils/pricing.js).
//  2. Loyalty discounts: viewing landlords whose subscription has run
//     consecutively for long enough to qualify, bulk-granting them a
//     discount percentage, and viewing/revoking active grants.

const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');
const pricingService = require('../services/subscriptionPricing.service');
const loyaltyService = require('../services/landlordLoyalty.service');

const ADMIN_ACTOR_ID = 'super-admin';

// ---------------------------------------------------------------------
// Subscription fee (base rate + period discount tiers)
// ---------------------------------------------------------------------

async function getSubscriptionPricing(req, res) {
  try {
    const history = await pricingService.getPricingHistory();
    return res.json(history);
  } catch (err) {
    logger.error('[subscriptionPricing] getSubscriptionPricing error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load subscription pricing.' });
  }
}

// PUBLIC (no auth) - just the current base rate + period discount
// tiers, nothing else (no loyalty data, no history). Used by the
// signup flow and "add a property" flow on the frontend so their
// live price preview always matches whatever admin last set here,
// instead of a hardcoded number that goes stale the moment admin
// changes the price.
async function getPublicSubscriptionPricing(req, res) {
  try {
    const settings = await pricingService.getCurrentPricingSettings();
    return res.json({
      baseRatePerUnitPerMonth: Number(settings.base_rate_per_unit_per_month),
      periodDiscounts: settings.period_discounts || {},
    });
  } catch (err) {
    logger.error('[subscriptionPricing] getPublicSubscriptionPricing error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load subscription pricing.' });
  }
}

function validatePricingPayload(body) {
  const result = {};

  if (body.baseRatePerUnitPerMonth != null) {
    const rate = Number(body.baseRatePerUnitPerMonth);
    if (Number.isNaN(rate) || rate < 0) {
      return { error: 'baseRatePerUnitPerMonth must be a non-negative number.' };
    }
    result.baseRatePerUnitPerMonth = rate;
  }

  if (body.periodDiscounts != null) {
    if (typeof body.periodDiscounts !== 'object' || Array.isArray(body.periodDiscounts)) {
      return { error: 'periodDiscounts must be an object like {"3": 0.05, "6": 0.10, "12": 0.15}.' };
    }
    for (const [months, discount] of Object.entries(body.periodDiscounts)) {
      const m = Number(months);
      const d = Number(discount);
      if (!Number.isFinite(m) || m < 1 || !Number.isFinite(d) || d < 0 || d > 1) {
        return { error: `Invalid period discount entry "${months}": "${months}" ${discount}. Months must be >= 1, discount a fraction between 0 and 1.` };
      }
    }
    result.periodDiscounts = body.periodDiscounts;
  }

  if (result.baseRatePerUnitPerMonth == null && result.periodDiscounts == null) {
    return { error: 'Provide at least baseRatePerUnitPerMonth or periodDiscounts to update.' };
  }

  let effectiveFrom = new Date();
  if (body.effectiveFrom) {
    const parsed = new Date(body.effectiveFrom);
    if (Number.isNaN(parsed.getTime())) return { error: 'effectiveFrom must be a valid date.' };
    effectiveFrom = parsed;
  }
  result.effectiveFrom = effectiveFrom;

  return result;
}

async function updateSubscriptionPricing(req, res) {
  try {
    const parsed = validatePricingPayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { saved, previous } = await pricingService.setPricing({
      baseRatePerUnitPerMonth: parsed.baseRatePerUnitPerMonth,
      periodDiscounts: parsed.periodDiscounts,
      effectiveFrom: parsed.effectiveFrom,
      adminId: ADMIN_ACTOR_ID,
      note: req.body.note,
    });

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: 'subscription_pricing_updated',
      targetType: 'subscription_pricing_settings',
      targetId: saved.id,
      ipAddress: req.ip,
      metadata: { before: previous, after: saved },
    });

    return res.json({ pricing: saved });
  } catch (err) {
    logger.error('[subscriptionPricing] updateSubscriptionPricing error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update subscription pricing.' });
  }
}

// ---------------------------------------------------------------------
// Loyalty discounts
// ---------------------------------------------------------------------

async function getLoyaltyCandidates(req, res) {
  try {
    const minMonths = req.query.minMonths ? Number(req.query.minMonths) : loyaltyService.DEFAULT_MIN_CONSECUTIVE_MONTHS;
    const candidates = await loyaltyService.findConsecutiveLandlordCandidates(minMonths);
    return res.json({ candidates, minMonths });
  } catch (err) {
    logger.error('[subscriptionPricing] getLoyaltyCandidates error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load consecutive-subscription landlords.' });
  }
}

async function getActiveLoyaltyDiscounts(req, res) {
  try {
    const discounts = await loyaltyService.listActiveDiscounts();
    return res.json({ discounts });
  } catch (err) {
    logger.error('[subscriptionPricing] getActiveLoyaltyDiscounts error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load active loyalty discounts.' });
  }
}

// P4: full history (active + consumed + revoked + expired), optionally
// scoped to one landlord - see landlordLoyalty.service.js's
// listDiscountHistory for what each row includes.
async function getLoyaltyDiscountHistory(req, res) {
  try {
    const { landlordId } = req.query;
    const history = await loyaltyService.listDiscountHistory(landlordId || null);
    return res.json({ history });
  } catch (err) {
    logger.error('[subscriptionPricing] getLoyaltyDiscountHistory error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load loyalty discount history.' });
  }
}

async function bulkGrantLoyaltyDiscount(req, res) {
  try {
    const { landlordIds, discountPercentage, note, expiryDays } = req.body;
    if (!Array.isArray(landlordIds) || landlordIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one landlord.' });
    }
    const pct = Number(discountPercentage);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'discountPercentage must be between 0 and 100.' });
    }

    const result = await loyaltyService.bulkGrantLoyaltyDiscount({
      landlordIds,
      discountPercentage: pct,
      adminId: ADMIN_ACTOR_ID,
      note,
      expiryDays,
    });

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: 'loyalty_discount_bulk_granted',
      targetType: 'landlord_loyalty_discounts',
      targetId: result.batchId,
      ipAddress: req.ip,
      metadata: { landlordIds, discountPercentage: pct, expiryDays: expiryDays || loyaltyService.DEFAULT_DISCOUNT_EXPIRY_DAYS, granted: result.granted.length, errors: result.errors },
    });

    return res.json(result);
  } catch (err) {
    logger.error('[subscriptionPricing] bulkGrantLoyaltyDiscount error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to grant the loyalty discount.' });
  }
}

async function revokeLoyaltyDiscount(req, res) {
  try {
    const { landlordId } = req.params;
    const revoked = await loyaltyService.revokeLoyaltyDiscount(landlordId, ADMIN_ACTOR_ID);

    logActivity({
      actorType: 'admin',
      actorId: ADMIN_ACTOR_ID,
      action: 'loyalty_discount_revoked',
      targetType: 'landlord',
      targetId: landlordId,
      ipAddress: req.ip,
      metadata: { revoked },
    });

    return res.json({ revoked });
  } catch (err) {
    logger.error('[subscriptionPricing] revokeLoyaltyDiscount error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to revoke the loyalty discount.' });
  }
}

module.exports = {
  getSubscriptionPricing,
  getPublicSubscriptionPricing,
  updateSubscriptionPricing,
  getLoyaltyCandidates,
  getActiveLoyaltyDiscounts,
  getLoyaltyDiscountHistory,
  bulkGrantLoyaltyDiscount,
  revokeLoyaltyDiscount,
};
