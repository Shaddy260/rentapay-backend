// src/services/pricingProposal.service.js
//
// Phase 12 - Admin: Revenue Statistics & Pricing Proposal.
//
// Looks at real numbers (true MRR from Phase 13's coverage-period
// model, real BA commission payouts, real operating expenses) and
// proposes a price-per-unit and BA commission % that would hit an
// admin-chosen target profit margin. NEVER writes to
// subscription_pricing_settings or payout_rules itself - this is a
// read-only calculation; applying a proposal is a separate, deliberate
// admin action using the existing pricing/payout-rules screens.

const supabase = require('../config/supabase');
const { getMRRForMonth, getActiveLandlordsWithGrace } = require('./coveragePeriod.service');
const { expensesForMonth, monthKey } = require('./adminFinancialOverview.service');
const { getCurrentPricingSettings } = require('./subscriptionPricing.service');

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/** Rounds to the nearest multiple of `step` (spec: "round to a clean number, nearest KES 5"). */
function roundToNearest(n, step) {
  return Math.round(n / step) * step;
}

async function getBaCommissionPayoutsForMonth(key) {
  const { data, error } = await supabase.from('ba_commission_earnings').select('commission_amount').eq('billing_cycle', key);
  if (error) throw error;
  return (data || []).reduce((sum, e) => sum + Number(e.commission_amount || 0), 0);
}

/** Whichever global BA commission % is currently in force - same append-only-history model as payoutRules.controller.js's currentAndUpcoming('global', null). */
async function getCurrentGlobalCommissionPercentage() {
  const { data, error } = await supabase
    .from('payout_rules')
    .select('percentage')
    .eq('scope', 'global')
    .is('ba_id', null)
    .lte('effective_from', new Date().toISOString())
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.percentage) : 0;
}

/** Same churn definition as admin.controller.js's getRevenueDashboard (lapsed in the last 30 days / active-or-lapsed 30 days ago) - duplicated here in miniature rather than imported, since that handler computes several other unrelated things in the same round trip. */
async function getChurnRate30Days() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [{ count: churnedCount, error: churnedErr }, { count: baseCount, error: baseErr }] = await Promise.all([
    supabase
      .from('landlords')
      .select('id', { count: 'exact', head: true })
      .in('subscription_status', ['suspended', 'expired'])
      .gte('updated_at', thirtyDaysAgo.toISOString()),
    supabase
      .from('landlords')
      .select('id', { count: 'exact', head: true })
      .not('subscription_started_at', 'is', null)
      .lte('subscription_started_at', thirtyDaysAgo.toISOString()),
  ]);
  if (churnedErr) throw churnedErr;
  if (baseErr) throw baseErr;

  const base = baseCount || 0;
  return base > 0 ? Math.round(((churnedCount || 0) / base) * 10000) / 100 : null;
}

/**
 * @param {number} [targetMarginPct] - admin-adjustable target profit
 *   margin, e.g. 40 for 40%. Defaults to 40.
 * @param {string} [monthKeyStr] - 'YYYY-MM', defaults to the current month.
 */
async function getPricingProposal({ targetMarginPct, monthKeyStr } = {}) {
  const key = monthKeyStr || monthKey(new Date());
  const margin = Math.min(0.95, Math.max(0, (targetMarginPct != null ? Number(targetMarginPct) : 40) / 100));

  const [mrr, activeLandlords, baPayouts, expenses, pricingSettings, currentCommissionPct, churnRatePct] = await Promise.all([
    getMRRForMonth(new Date(`${key}-01T00:00:00Z`)),
    getActiveLandlordsWithGrace(),
    getBaCommissionPayoutsForMonth(key),
    expensesForMonth(key),
    getCurrentPricingSettings(),
    getCurrentGlobalCommissionPercentage(),
    getChurnRate30Days(),
  ]);

  const activeUnits = activeLandlords.reduce((sum, l) => sum + Number(l.unit_limit || 0), 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const netProfit = mrr - baPayouts - totalExpenses;
  const currentPricePerUnit = Number(pricingSettings.base_rate_per_unit_per_month);

  const inputs = {
    monthKey: key,
    mrr: round2(mrr),
    activeUnits,
    activeLandlordCount: activeLandlords.length,
    baCommissionPayouts: round2(baPayouts),
    operatingExpenses: round2(totalExpenses),
    netProfit: round2(netProfit),
    churnRatePct,
    targetMarginPct: Math.round(margin * 1000) / 10,
  };

  // Not enough data yet (e.g. brand-new platform, no active units) -
  // return current settings only, with proposed = current, rather
  // than dividing by zero or proposing something meaningless.
  if (activeUnits < 1) {
    return {
      inputs,
      current: { pricePerUnit: currentPricePerUnit, commissionPct: currentCommissionPct },
      proposed: { pricePerUnit: currentPricePerUnit, commissionPct: currentCommissionPct },
      breakEvenPricePerUnit: null,
      insufficientData: true,
    };
  }

  // Step 1-3: revenue/cost/profit per unit today.
  const revenuePerUnit = mrr / activeUnits;
  const totalCostPerUnit = (baPayouts + totalExpenses) / activeUnits; // the key idea: cost per unit includes what's actually paid to BAs, not just running costs
  const currentProfitPerUnit = revenuePerUnit - totalCostPerUnit;

  // Step 4: break-even floor.
  const breakEvenPricePerUnit = totalCostPerUnit;

  // Step 5: proposed price = total cost per unit / (1 - target margin).
  let rawProposedPrice = totalCostPerUnit / (1 - margin);

  // Step 6: guardrails - never below break-even, never more than ~20%
  // above the current price, round to the nearest KES 5.
  //
  // FIX ("proposed price is stuck at 60 even when I move the slider,
  // only the % moves"): this used to ALSO clamp the price up to a
  // capLow of currentPricePerUnit * 0.8 - so whenever the real,
  // margin-driven price (totalCostPerUnit / (1 - margin)) computed
  // below that floor, which it does for basically the entire 5-80%
  // slider range whenever true cost-per-unit is well under the
  // current price, capLow silently won and the proposed price was
  // pinned to the exact same number regardless of the margin chosen.
  // The break-even floor just above is already the correct lower
  // bound (never propose a price that loses money) - re-flooring at
  // 80% of the CURRENT price on top of that defeats the whole point
  // of the slider. Only the upper cap remains, to stop a cost spike
  // from proposing a wild price jump.
  rawProposedPrice = Math.max(rawProposedPrice, breakEvenPricePerUnit);
  const capHigh = currentPricePerUnit * 1.2;
  rawProposedPrice = Math.min(rawProposedPrice, capHigh);
  const proposedPricePerUnit = Math.max(5, roundToNearest(rawProposedPrice, 5));

  // Commission proposal, calculated AT the proposed price (not the
  // current one) so the two numbers stay consistent with each other:
  // "what commission % could we sustainably pay if we charged
  // proposedPricePerUnit and still hit the target margin".
  const revenueAtProposedPrice = proposedPricePerUnit * activeUnits;
  const sustainableBaPayouts = Math.max(0, revenueAtProposedPrice * (1 - margin) - totalExpenses);
  let proposedCommissionPct = revenueAtProposedPrice > 0 ? (sustainableBaPayouts / revenueAtProposedPrice) * 100 : 0;
  proposedCommissionPct = Math.round(Math.min(100, Math.max(0, proposedCommissionPct)) * 10) / 10;

  return {
    inputs: { ...inputs, revenuePerUnit: round2(revenuePerUnit), totalCostPerUnit: round2(totalCostPerUnit), currentProfitPerUnit: round2(currentProfitPerUnit) },
    current: { pricePerUnit: currentPricePerUnit, commissionPct: currentCommissionPct },
    proposed: { pricePerUnit: proposedPricePerUnit, commissionPct: proposedCommissionPct },
    breakEvenPricePerUnit: round2(breakEvenPricePerUnit),
    insufficientData: false,
  };
}

module.exports = { getPricingProposal };
