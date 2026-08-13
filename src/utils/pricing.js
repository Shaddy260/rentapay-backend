// src/utils/pricing.js
//
// Implements blueprint section 9.1: per-unit subscription pricing with
// discounts for longer commitment periods.
//
// UPDATE (admin-configurable pricing + loyalty discounts): the base
// rate and period-discount tiers used to be hardcoded constants here.
// They're now admin-editable (see AdminSubscriptionPricing.jsx /
// subscriptionPricing.controller.js) and stored in
// subscription_pricing_settings - see
// sql/2026-08-subscription-pricing-and-loyalty-discounts.sql. A change
// there is picked up here immediately (short in-memory cache, see
// subscriptionPricing.service.js) and flows through to every place
// that charges a landlord: signup, adding a property, adding units
// mid-period, and renewing a subscription - all of them call
// calculateSubscriptionCost() below, so there's exactly one place the
// rate actually lives.
//
// This file's functions are now ASYNC (they read from the DB) -
// every call site must `await` them.
//
// Also layers in a landlord's loyalty discount, if any (see
// landlordLoyalty.service.js): a landlord who has been bulk-granted a
// loyalty discount for consecutively subscribing gets that percentage
// off on top of whatever period-length discount already applies,
// automatically, on their next charge - no admin action needed per
// landlord after the initial grant. Pass a landlordId to have this
// applied; omit it (e.g. brand-new signups, who can't yet have a
// grant) to skip the lookup entirely.

const { getCurrentPricingSettings } = require('../services/subscriptionPricing.service');
const { getActiveDiscountForLandlord, getActiveDiscountRecordForLandlord } = require('../services/landlordLoyalty.service');

function resolvePeriodDiscount(periodDiscounts, periodMonths) {
  // period_discounts is stored as a JSON object keyed by minimum whole
  // months, e.g. {"3": 0.05, "6": 0.10, "12": 0.15}. Same threshold
  // behaviour as before: use the highest tier whose key is <=
  // periodMonths.
  const tiers = Object.entries(periodDiscounts || {})
    .map(([months, discount]) => [Number(months), Number(discount)])
    .filter(([months, discount]) => Number.isFinite(months) && Number.isFinite(discount))
    .sort((a, b) => b[0] - a[0]); // largest threshold first

  for (const [months, discount] of tiers) {
    if (periodMonths >= months) return discount;
  }
  return 0;
}

/**
 * Calculates subscription cost.
 *
 * FIX (direct request): "don't fix the subscription period - let the
 * landlord enter their own subscription time they wish". Any whole
 * number of months >= 1 is accepted; the discount tiers apply by
 * threshold (>=12 gets the 12-month rate, >=6 gets the 6-month rate,
 * and so on) instead of requiring an exact match.
 *
 * @param {number} unitsCount
 * @param {number} periodMonths - any whole number >= 1
 * @param {string|null} landlordId - if given, that landlord's active
 *   loyalty discount (if any) is applied on top of the period
 *   discount. Omit for flows where the landlord doesn't exist yet
 *   (e.g. signup).
 * @returns {Promise<{ ratePerUnitPerMonth: number, totalCost: number, discount: number, periodDiscount: number, loyaltyDiscount: number, loyaltyDiscountId: string|null, baseRatePerUnitPerMonth: number }>}
 */
async function calculateSubscriptionCost(unitsCount, periodMonths, landlordId = null) {
  periodMonths = Math.round(Number(periodMonths));
  if (!Number.isFinite(periodMonths) || periodMonths < 1) {
    throw new Error(`Invalid subscription period: ${periodMonths}. Must be a whole number of months, 1 or more.`);
  }
  if (unitsCount < 1) {
    throw new Error('unitsCount must be at least 1');
  }

  const settings = await getCurrentPricingSettings();
  const baseRate = Number(settings.base_rate_per_unit_per_month);
  const periodDiscount = resolvePeriodDiscount(settings.period_discounts, periodMonths);

  // loyaltyDiscountId is the id of whichever discount grant is
  // currently active for this landlord (or null if none). Callers
  // about to record a renewal payment (STK or manual) should persist
  // this id on that payment row, so ONE-TIME CONSUMPTION (see
  // landlordLoyalty.service.js's consumeLoyaltyDiscount) can later
  // deactivate exactly the discount that was actually used, once the
  // payment is confirmed complete - not "whatever happens to be active
  // at that later moment", which could differ if another payment
  // consumed it first.
  const discountRecord = landlordId ? await getActiveDiscountRecordForLandlord(landlordId) : null;
  const loyaltyDiscountPct = discountRecord ? Number(discountRecord.discount_percentage) : 0;
  const loyaltyDiscount = loyaltyDiscountPct / 100;

  // Discounts stack additively (period discount + loyalty discount),
  // capped at 100% so a data-entry mistake can never produce a
  // negative price.
  const discount = Math.min(1, periodDiscount + loyaltyDiscount);

  const ratePerUnitPerMonth = Math.round(baseRate * (1 - discount) * 100) / 100;
  // Discount applies to the TOTAL renewal amount: it's baked into the
  // per-unit rate above, which is then multiplied out by units and
  // months - so a landlord's discount reduces what they pay for their
  // whole renewal, not just a flat one-off amount.
  const totalCost = Math.round(ratePerUnitPerMonth * unitsCount * periodMonths * 100) / 100;

  return {
    ratePerUnitPerMonth,
    totalCost,
    discount,
    periodDiscount,
    loyaltyDiscount,
    loyaltyDiscountId: discountRecord ? discountRecord.id : null,
    baseRatePerUnitPerMonth: baseRate,
  };
}

/**
 * Pro-rates the cost of adding units mid-subscription-period
 * (blueprint 9.3: "new units x rate x remaining months"). Also
 * respects the landlord's loyalty discount, if any, since it's the
 * same ongoing subscription.
 */
async function calculateAddUnitsCost(additionalUnits, remainingMonths, landlordId = null) {
  const settings = await getCurrentPricingSettings();
  const baseRate = Number(settings.base_rate_per_unit_per_month);
  const loyaltyDiscountPct = landlordId ? await getActiveDiscountForLandlord(landlordId) : 0;
  const rate = Math.round(baseRate * (1 - loyaltyDiscountPct / 100) * 100) / 100;
  const totalCost = Math.round(rate * additionalUnits * remainingMonths * 100) / 100;
  return totalCost;
}

module.exports = { calculateSubscriptionCost, calculateAddUnitsCost };
