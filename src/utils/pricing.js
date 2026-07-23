// src/utils/pricing.js
//
// Implements blueprint section 9.1: per-unit subscription pricing with
// discounts for longer commitment periods.
//
// Base rate: KES 50 / unit / month
// NOTE: the original blueprint specifies KES 150/unit/month - changed
// to 70 per an earlier direct instruction, then to 50 per a further
// direct instruction. Discount percentages (5%/10%/15% for 3/6/12
// months) are unchanged, applied against the new base rate.
// Discounts: 1mo = 0%, 3mo = 5%, 6mo = 10%, 12mo = 15%

const BASE_RATE_PER_UNIT_PER_MONTH = 50;

const PERIOD_DISCOUNTS = {
  1: 0,
  3: 0.05,
  6: 0.10,
  12: 0.15,
};

/**
 * Calculates subscription cost.
 *
 * FIX (direct request): "don't fix the subscription period - let the
 * landlord enter their own subscription time they wish". This used to
 * hard-reject any period that wasn't exactly 1, 3, 6, or 12 months,
 * which is the whole reason the frontend was ever locked to a fixed
 * dropdown in the first place. Any whole number of months >= 1 is
 * accepted now; the discount tiers still apply, just by threshold
 * (>=12 gets the 12-month rate, >=6 gets the 6-month rate, and so on)
 * instead of requiring an exact match.
 * @param {number} unitsCount
 * @param {number} periodMonths - any whole number >= 1
 * @returns {{ ratePerUnitPerMonth: number, totalCost: number, discount: number }}
 */
function discountForPeriod(periodMonths) {
  if (periodMonths >= 12) return PERIOD_DISCOUNTS[12];
  if (periodMonths >= 6) return PERIOD_DISCOUNTS[6];
  if (periodMonths >= 3) return PERIOD_DISCOUNTS[3];
  return PERIOD_DISCOUNTS[1];
}

function calculateSubscriptionCost(unitsCount, periodMonths) {
  periodMonths = Math.round(Number(periodMonths));
  if (!Number.isFinite(periodMonths) || periodMonths < 1) {
    throw new Error(`Invalid subscription period: ${periodMonths}. Must be a whole number of months, 1 or more.`);
  }
  if (unitsCount < 1) {
    throw new Error('unitsCount must be at least 1');
  }

  const discount = discountForPeriod(periodMonths);
  const ratePerUnitPerMonth = Math.round(BASE_RATE_PER_UNIT_PER_MONTH * (1 - discount) * 100) / 100;
  const totalCost = Math.round(ratePerUnitPerMonth * unitsCount * periodMonths * 100) / 100;

  return { ratePerUnitPerMonth, totalCost, discount };
}

/**
 * Pro-rates the cost of adding units mid-subscription-period
 * (blueprint 9.3: "new units × KES 150 × remaining months").
 */
function calculateAddUnitsCost(additionalUnits, remainingMonths) {
  const totalCost = Math.round(BASE_RATE_PER_UNIT_PER_MONTH * additionalUnits * remainingMonths * 100) / 100;
  return totalCost;
}

module.exports = { BASE_RATE_PER_UNIT_PER_MONTH, PERIOD_DISCOUNTS, calculateSubscriptionCost, calculateAddUnitsCost };
