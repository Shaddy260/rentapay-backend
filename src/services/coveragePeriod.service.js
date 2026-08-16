// src/services/coveragePeriod.service.js
//
// Phase 13 - Subscription Coverage Periods & True Monthly Recurring
// Revenue. See sql/2026-08-phase12-13-coverage-periods-and-pricing-proposal.sql
// for the table this reads/writes.
//
// Every landlord payment that activates or extends their subscription
// (first payment, renewal, or a mid-cycle unit addition) creates its
// own coverage-period row here, alongside whatever it already does to
// the landlords table (unit_limit/subscription_expires_at/etc - all of
// that stays exactly as-is; this is purely additive bookkeeping for
// revenue recognition). MRR for any month is the sum of every period's
// normalized_monthly_value whose [start_date, end_date] window
// overlaps that month - see getMRRForMonth() below.

const supabase = require('../config/supabase');
const { captureException } = require('./sentry.service');
const logger = require('../utils/logger');

/**
 * Where a NEW coverage period should start, given the landlord's
 * PREVIOUS subscription_expires_at (before this payment extends it).
 *
 * - No previous expiry, or it's already in the past (standard renewal,
 *   or first-ever payment): the new period starts now - there was a
 *   real gap (or no history at all), so backdating it further would
 *   misattribute months nobody was actually covered for.
 * - Previous expiry is still in the future (early renewal - the
 *   landlord paid again before their current period ran out): the new
 *   period starts the day AFTER the existing one ends, never the date
 *   the payment happened to land on. This is what prevents
 *   double-counting - the days/months already paid for stay
 *   attributed to the original period; the new payment only starts
 *   contributing to MRR once that original period genuinely runs out.
 */
function computeRenewalStartDate(previousExpiresAt) {
  const now = new Date();
  if (previousExpiresAt) {
    const prev = new Date(previousExpiresAt);
    if (prev > now) {
      const dayAfter = new Date(prev);
      dayAfter.setDate(dayAfter.getDate() + 1);
      return dayAfter;
    }
  }
  return now;
}

/** Whole (fractional) months between two dates, floored at a minimum of 1 - a coverage period can never normalize to "per 0 months". */
function monthsBetween(start, end) {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const months = ms / (1000 * 60 * 60 * 24 * 30.4375); // average month length, consistent with how period_months-based rows are normalized elsewhere
  return Math.max(months, 1 / 30.4375); // never fully zero - guards the division below for a same-day addon
}

/**
 * Creates one coverage-period record. `periodMonths`, if given, is used
 * directly as the normalization divisor (matches exactly what the
 * landlord was actually charged for - e.g. "3 months" - rather than a
 * date-math approximation). Omit it (e.g. for a mid-cycle addon, whose
 * length is whatever's left of the current term, not a round number of
 * months) to normalize from the actual start/end date range instead.
 */
async function createCoveragePeriod({
  landlordId,
  kind,
  startDate,
  endDate,
  unitsCovered,
  amountPaid,
  periodMonths,
  subscriptionPaymentId = null,
  manualSubscriptionPaymentId = null,
}) {
  try {
    const months = periodMonths && periodMonths > 0 ? Number(periodMonths) : monthsBetween(startDate, endDate);
    const normalizedMonthlyValue = Math.round((Number(amountPaid) / months) * 100) / 100;

    const { data, error } = await supabase
      .from('subscription_coverage_periods')
      .insert({
        landlord_id: landlordId,
        kind,
        start_date: new Date(startDate).toISOString(),
        end_date: new Date(endDate).toISOString(),
        units_covered: Math.max(1, Math.round(Number(unitsCovered) || 1)),
        amount_paid: Number(amountPaid) || 0,
        normalized_monthly_value: normalizedMonthlyValue,
        subscription_payment_id: subscriptionPaymentId,
        manual_subscription_payment_id: manualSubscriptionPaymentId,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    // A coverage-period write failing should never block the
    // subscription activation/renewal itself from completing (the
    // landlord already paid and their access already changed by the
    // time this is called) - this is downstream analytics
    // bookkeeping, logged loudly so it can be backfilled/investigated,
    // not a reason to roll back or fail the payment flow.
    logger.error(`[coveragePeriod] Failed to create coverage period for landlord ${landlordId}:`, err.message);
    captureException(err);
    return null;
  }
}

function monthBounds(monthDate) {
  const d = monthDate ? new Date(monthDate) : new Date();
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * True MRR for a given month = sum of every coverage period's
 * normalized_monthly_value whose date range overlaps that month, no
 * matter which month the underlying payment actually landed in. See
 * the Phase 13 spec's worked example: a landlord prepaying 6 months
 * contributes 1/6th of that payment to each of the 6 months it
 * actually covers, not the whole amount to the month they paid.
 */
async function getMRRForMonth(monthDate) {
  const { start, end } = monthBounds(monthDate);
  const { data, error } = await supabase
    .from('subscription_coverage_periods')
    .select('normalized_monthly_value')
    .lt('start_date', end.toISOString())
    .gte('end_date', start.toISOString());
  if (error) throw error;
  const mrr = (data || []).reduce((sum, p) => sum + Number(p.normalized_monthly_value || 0), 0);
  return Math.round(mrr * 100) / 100;
}

/**
 * "Active landlords" per Phase 13's coverage-period model, tolerating
 * the ordinary gap between one coverage period ending and the next
 * renewal payment landing (a landlord who pays a few days late is
 * still "active" throughout - not dropped from MRR/active-count just
 * because the payment didn't land on the exact expiry date).
 *
 * Scope note: this reads the landlord's real subscription_status too
 * (never overrides an admin-suspended account into "active") - the
 * grace window only widens how *lapsed timing* is tolerated, it never
 * substitutes for an explicit suspension. This is the read model used
 * by Phase 12's pricing proposal and the admin revenue dashboard; it
 * does NOT change the landlord's actual paywall/access, which stays
 * governed entirely by the existing subscription_status column and
 * cron-driven expiry sweep, untouched by this function.
 */
async function getActiveLandlordsWithGrace(graceDays = 7) {
  const graceCutoff = new Date();
  graceCutoff.setDate(graceCutoff.getDate() - graceDays);

  const { data: periods, error: periodsErr } = await supabase
    .from('subscription_coverage_periods')
    .select('landlord_id, end_date');
  if (periodsErr) throw periodsErr;

  const latestEndByLandlord = new Map();
  for (const p of periods || []) {
    const end = new Date(p.end_date);
    const existing = latestEndByLandlord.get(p.landlord_id);
    if (!existing || end > existing) latestEndByLandlord.set(p.landlord_id, end);
  }

  const activeLandlordIds = [...latestEndByLandlord.entries()]
    .filter(([, latestEnd]) => latestEnd >= graceCutoff)
    .map(([landlordId]) => landlordId);

  if (activeLandlordIds.length === 0) return [];

  const { data: landlords, error: landlordsErr } = await supabase
    .from('landlords')
    .select('id, full_name, unit_limit, subscription_status')
    .in('id', activeLandlordIds)
    .neq('subscription_status', 'suspended'); // see scope note above - a suspension always wins over the grace window
  if (landlordsErr) throw landlordsErr;

  return landlords || [];
}

module.exports = {
  computeRenewalStartDate,
  createCoveragePeriod,
  getMRRForMonth,
  getActiveLandlordsWithGrace,
  monthBounds,
};
