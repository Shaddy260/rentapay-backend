// src/services/baCommission.service.js
//
// Consolidated Change Instructions - Section E (percentage commission,
// hard cutover replacing the fixed-price model).
//
// Two responsibilities:
//   1. resolveApplicableRate(baId, atDate) - the rate lookup Section E
//      specifies: "whichever rate row has the latest effective_from at
//      or before that payment's paid_at" - a BA override, if one
//      exists and has a row at-or-before atDate, wins outright over
//      the global rate (same override-fully-replaces-global precedence
//      already used elsewhere in this codebase for payout_rules /
//      commission_tiers). If the BA has no override at all (or none
//      effective yet as of atDate), the global rate is used instead.
//   2. recordCommissionForPayment(payment) - called from the
//      payment-processing path (payment.controller.js,
//      processSubscriptionPaymentCallback) the moment a landlord's
//      subscription payment completes. Computes
//      commission = payment_amount x applicable_percentage and writes
//      one ba_commission_earnings row, ONLY for landlords that are (a)
//      attached to a BA and (b) already qualified (Section C's gate -
//      unaffected by this payment itself; qualification is a one-time
//      flip, this function never sets it). Idempotent: a unique index
//      on subscription_payment_id means a re-invocation for the same
//      payment (webhook retry, etc.) is a harmless no-op.

const supabase = require('../config/supabase');
const { notify } = require('./notify.service');
const { logActivity } = require('./activityLog.service');
const { captureException } = require('./sentry.service');
const logger = require('../utils/logger');

function billingCycleFor(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Resolves the percentage rate that applies to a BA at a given moment,
 * per Section E's lookup: latest effective_from at or before atDate,
 * BA override taking full precedence over global whenever one exists
 * at that point in time.
 *
 * @param {string} baId
 * @param {Date|string} atDate - normally a payment's paid_at
 * @returns {Promise<{ percentage: number, payoutRuleId: string } | null>}
 */
async function resolveApplicableRate(baId, atDate) {
  const asOf = new Date(atDate).toISOString();

  // Phase 8: a reward override is time-bound (effective_until set) -
  // once `asOf` passes that timestamp the row must stop being picked
  // up here, which is exactly what makes the reward "automatically
  // revert to the universal default rate, no manual step required."
  // Plain (non-reward) overrides never set effective_until, so this
  // filter is a no-op for them - existing behaviour is unchanged.
  const { data: overrideRows, error: overrideErr } = await supabase
    .from('payout_rules')
    .select('id, percentage, effective_from, effective_until')
    .eq('scope', 'ba_override')
    .eq('ba_id', baId)
    .lte('effective_from', asOf)
    .or(`effective_until.is.null,effective_until.gt.${asOf}`)
    .order('effective_from', { ascending: false })
    .limit(1);
  if (overrideErr) throw overrideErr;

  if (overrideRows && overrideRows.length > 0) {
    return { percentage: Number(overrideRows[0].percentage), payoutRuleId: overrideRows[0].id };
  }

  const { data: globalRows, error: globalErr } = await supabase
    .from('payout_rules')
    .select('id, percentage, effective_from')
    .eq('scope', 'global')
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
    .limit(1);
  if (globalErr) throw globalErr;

  if (globalRows && globalRows.length > 0) {
    return { percentage: Number(globalRows[0].percentage), payoutRuleId: globalRows[0].id };
  }

  return null; // no rate has ever been set as of this date - nothing to compute against
}

/**
 * Computes and records commission for one completed landlord
 * subscription payment. Safe/idempotent to call more than once for
 * the same payment. Never throws out to the caller - a commission
 * bookkeeping failure must never block the payment-completion flow
 * that triggered it; errors are logged/captured and swallowed, same
 * convention as the notify() calls right next to this call site.
 *
 * BA attribution is per-PROPERTY now (see
 * sql/2026-08-per-property-ba-attribution.sql), not per-landlord
 * account - `landlords.ba_id` only ever meant "who onboarded this
 * landlord's original/day-one property," and that's still exactly
 * what it's used for below by default. Every existing call site
 * (subscription_payments renewals of that original property, the
 * manual-payment flow, and the qualification backfill job) is about
 * that same original property, so the default landlord-lookup path
 * is unchanged and still correct for them.
 *
 * A caller working with a DIFFERENT property (e.g. a later "add a
 * property" purchase, which carries its own independent ba_id/
 * ba_qualification_status on the properties row - see
 * property.controller.js) should pass `baId` and
 * `qualificationStatus` explicitly instead of relying on the
 * landlord-lookup default, once that payment type is wired into
 * commission recording. This function does not do that wiring itself
 * yet - ba_commission_earnings.subscription_payment_id is a NOT NULL
 * FK to subscription_payments, so recording commission for a
 * property_payments purchase needs its own schema decision (new
 * column vs. new table) before this can be pointed at that flow.
 *
 * @param {object} subPayment - the payment row, must include: id,
 *   landlord_id, amount, paid_at
 * @param {object} [attribution] - optional explicit override
 * @param {string} [attribution.baId] - BA to credit, bypassing the
 *   landlords.ba_id lookup
 * @param {string} [attribution.qualificationStatus] - 'qualified' |
 *   'pending', bypassing landlords.ba_qualification_status
 */
async function recordCommissionForPayment(subPayment, attribution = {}) {
  try {
    let baId = attribution.baId;
    let qualificationStatus = attribution.qualificationStatus;
    let landlordId = subPayment.landlord_id;

    if (!baId) {
      const { data: landlord, error: landlordErr } = await supabase
        .from('landlords')
        .select('id, ba_id, ba_qualification_status, full_name')
        .eq('id', subPayment.landlord_id)
        .maybeSingle();
      if (landlordErr) throw landlordErr;
      if (!landlord) return null;
      baId = landlord.ba_id;
      qualificationStatus = landlord.ba_qualification_status;
      landlordId = landlord.id;
    }

    // Section E: "percentage commission only applies to landlords
    // that have already qualified" - Section C's gate, read here, not
    // re-derived.
    if (!baId || qualificationStatus !== 'qualified') return null;

    const paidAt = subPayment.paid_at || new Date().toISOString();
    const rate = await resolveApplicableRate(baId, paidAt);
    if (!rate) {
      logger.warn(`[baCommission] no payout_rules rate resolvable for BA ${baId} as of ${paidAt} - skipping commission for payment ${subPayment.id}.`);
      return null;
    }

    const paymentAmount = Number(subPayment.amount || 0);
    const commissionAmount = Math.round(paymentAmount * (rate.percentage / 100) * 100) / 100;

    const { data: inserted, error: insertErr } = await supabase
      .from('ba_commission_earnings')
      .insert({
        ba_id: baId,
        landlord_id: landlordId,
        subscription_payment_id: subPayment.id,
        payment_amount: paymentAmount,
        percentage_applied: rate.percentage,
        commission_amount: commissionAmount,
        payout_rule_id: rate.payoutRuleId,
        billing_cycle: billingCycleFor(paidAt),
        paid_at: paidAt,
      })
      .select()
      .maybeSingle();

    if (insertErr) {
      // Unique violation on subscription_payment_id = this payment's
      // commission was already recorded (retry/duplicate callback) -
      // not a real error, nothing further to do.
      if (insertErr.code === '23505') return null;
      throw insertErr;
    }

    logActivity({
      actorType: 'system',
      action: 'ba_commission_recorded',
      targetType: 'brand_ambassador',
      targetId: baId,
      metadata: {
        landlordId,
        subscriptionPaymentId: subPayment.id,
        paymentAmount,
        percentageApplied: rate.percentage,
        commissionAmount,
      },
    });

    return inserted;
  } catch (err) {
    logger.error(`[baCommission] recordCommissionForPayment failed for payment ${subPayment?.id}:`, err.message);
    captureException(err);
    return null;
  }
}

/**
 * Notifies every BA affected by a rate change - the BA an override was
 * just set/cleared for, or, for a global change, every active/
 * suspended BA who does NOT currently have their own override (an
 * override fully replaces the global rate for that BA, so a global
 * change doesn't affect them). Both in-app and push, per Section E.
 */
async function notifyRateChange({ scope, baId, oldPercentage, newPercentage, effectiveFrom }) {
  const effectiveLabel = new Date(effectiveFrom) <= new Date()
    ? 'immediately'
    : `from ${new Date(effectiveFrom).toLocaleDateString('en-GB')}`;
  const oldLabel = oldPercentage == null ? 'no rate previously set' : `${oldPercentage}%`;
  const message = `Your commission rate is changing from ${oldLabel} to ${newPercentage}%, effective ${effectiveLabel}.`;

  async function sendTo(id) {
    try {
      await notify('brand_ambassador', id, null, message, {
        category: 'commission_rate_changed',
        title: 'Commission rate updated',
      });
    } catch (err) {
      logger.error(`[baCommission] rate-change notify failed for BA ${id}:`, err.message);
      captureException(err);
    }
  }

  if (scope === 'ba_override') {
    await sendTo(baId);
    return;
  }

  // Global change: every active/suspended BA without their own
  // override is affected.
  const { data: bas, error: basErr } = await supabase
    .from('brand_ambassadors')
    .select('id')
    .in('status', ['active', 'suspended']);
  if (basErr) {
    logger.error('[baCommission] rate-change notify: failed to list BAs:', basErr.message);
    captureException(basErr);
    return;
  }

  const { data: overriddenRows, error: overriddenErr } = await supabase
    .from('payout_rules')
    .select('ba_id')
    .eq('scope', 'ba_override');
  if (overriddenErr) {
    logger.error('[baCommission] rate-change notify: failed to list overrides:', overriddenErr.message);
    captureException(overriddenErr);
    return;
  }
  const overriddenBaIds = new Set((overriddenRows || []).map((r) => r.ba_id));

  const targets = (bas || []).filter((b) => !overriddenBaIds.has(b.id));
  await Promise.all(targets.map((b) => sendTo(b.id)));
}

module.exports = {
  resolveApplicableRate,
  recordCommissionForPayment,
  notifyRateChange,
  billingCycleFor,
};
