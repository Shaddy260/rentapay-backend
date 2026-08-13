// src/services/subscriptionPricing.service.js
//
// Backs the admin-editable subscription fee (base rate per unit per
// month) and period-length discount tiers, replacing the values that
// used to be hardcoded constants in utils/pricing.js. See
// sql/2026-08-subscription-pricing-and-loyalty-discounts.sql.
//
// Same append-only-history pattern as payout_rules
// (payoutRules.controller.js / baCommission.service.js): setting a new
// rate inserts a new row with its own effective_from rather than
// overwriting the current one, so past rates are never lost and a
// future-dated change can be scheduled ahead of time.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');

// Fallback used only if the settings table is ever completely empty
// (e.g. migration hasn't run yet) - mirrors the old hardcoded
// constants so nothing regresses to "can't calculate a price at all".
const FALLBACK_SETTINGS = {
  base_rate_per_unit_per_month: 50,
  period_discounts: { 3: 0.05, 6: 0.10, 12: 0.15 },
  effective_from: null,
};

let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 15_000; // short TTL: admin changes should take effect quickly

function invalidateCache() {
  cache = null;
  cacheAt = 0;
}

/**
 * Returns whichever pricing row is currently in force (latest
 * effective_from <= now).
 */
async function getCurrentPricingSettings() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;

  const { data, error } = await supabase
    .from('subscription_pricing_settings')
    .select('*')
    .lte('effective_from', new Date().toISOString())
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error('[subscriptionPricing] failed to load pricing settings, using fallback:', error.message);
    return FALLBACK_SETTINGS;
  }

  const settings = data || FALLBACK_SETTINGS;
  cache = settings;
  cacheAt = Date.now();
  return settings;
}

/**
 * Full current/upcoming/history view, mirroring
 * payoutRules.controller.js's currentAndUpcoming - powers the admin
 * settings screen.
 */
async function getPricingHistory() {
  const { data, error } = await supabase
    .from('subscription_pricing_settings')
    .select('*')
    .order('effective_from', { ascending: false });
  if (error) throw error;

  const rows = data || [];
  const now = new Date();
  const current = rows.find((r) => new Date(r.effective_from) <= now) || null;
  const upcoming = rows
    .filter((r) => new Date(r.effective_from) > now)
    .sort((a, b) => new Date(a.effective_from) - new Date(b.effective_from));
  const history = rows.filter((r) => new Date(r.effective_from) <= now);

  return { current, upcoming, history };
}

/**
 * Inserts a new pricing row (base rate and/or period discount tiers).
 * Any field omitted from `updates` carries forward from the current
 * row, so an admin can change just the base rate without having to
 * re-type every discount tier.
 */
async function setPricing({ baseRatePerUnitPerMonth, periodDiscounts, effectiveFrom, adminId, note }) {
  const { current } = await getPricingHistory();

  const row = {
    base_rate_per_unit_per_month:
      baseRatePerUnitPerMonth != null ? Number(baseRatePerUnitPerMonth) : current ? Number(current.base_rate_per_unit_per_month) : FALLBACK_SETTINGS.base_rate_per_unit_per_month,
    period_discounts: periodDiscounts != null ? periodDiscounts : current ? current.period_discounts : FALLBACK_SETTINGS.period_discounts,
    effective_from: (effectiveFrom ? new Date(effectiveFrom) : new Date()).toISOString(),
    set_by_admin_id: adminId || 'super-admin',
    note: note || null,
  };

  const { data: saved, error } = await supabase.from('subscription_pricing_settings').insert(row).select().single();
  if (error) throw error;

  invalidateCache();
  return { saved, previous: current };
}

module.exports = {
  getCurrentPricingSettings,
  getPricingHistory,
  setPricing,
  invalidateCache,
};
