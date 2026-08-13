// src/controllers/subscription.controller.js
//
// Implements blueprint 9.3 (add/remove units mid-period) and 9.4
// (renewal reminder/renewal flow). Registration's first payment is
// handled in auth.controller.js + payment.controller.js; this file
// covers what happens AFTER a landlord already has an account.

const supabase = require('../config/supabase');
const { calculateSubscriptionCost, calculateAddUnitsCost } = require('../utils/pricing');
const { initiateSTKPush } = require('../services/daraja.service');
const { logActivity } = require('../services/activityLog.service');
const { effectiveLandlordId } = require('../middleware/auth.middleware');
const { captureException } = require('../services/sentry.service');
const loyaltyService = require('../services/landlordLoyalty.service');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------
// RENEW SUBSCRIPTION (blueprint 9.4 + 11.2: "Renew subscription via M-Pesa")
// ---------------------------------------------------------------------
async function renewSubscription(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { plan, periodMonths, unitsCount } = req.body;

    const { data: landlord, error: fetchError } = await supabase.from('landlords').select('*').eq('id', landlordId).single();
    if (fetchError || !landlord) return res.status(404).json({ error: 'Landlord not found.' });

    const { totalCost, loyaltyDiscountId } = await calculateSubscriptionCost(Number(unitsCount), Number(periodMonths), landlordId);

    // Same manual-payment fallback as the other STK entry points
    // (signup, add/renew a property) - an STK failure here used to
    // just 500, even though this page already has a manual-payment
    // form sitting right below it that the landlord could use anyway.
    let stkResponse = null;
    let stkFailureReason = null;
    try {
      stkResponse = await initiateSTKPush({
        phoneNumber: landlord.phone,
        amount: totalCost,
        accountReference: `RENTAPAY-RENEW-${landlordId.slice(0, 8)}`,
        transactionDesc: 'RentaPay subscription renewal',
      });
    } catch (stkErr) {
      logger.error('[subscription] STK push failed on renewal - falling back to manual payment:', stkErr.message);
      captureException(stkErr);
      stkFailureReason = stkErr.message;
    }

    const { data: subPayment, error } = await supabase
      .from('subscription_payments')
      .insert({
        landlord_id: landlordId,
        plan,
        period_months: periodMonths,
        units_count: unitsCount,
        amount: totalCost,
        mpesa_checkout_request_id: stkResponse ? stkResponse.CheckoutRequestID : null,
        status: 'pending',
        // ONE-TIME DISCOUNT CONSUMPTION: captures which loyalty
        // discount (if any) was active at the moment this renewal was
        // initiated. Only actually consumed once the Daraja callback
        // confirms this payment completed - see
        // processSubscriptionPaymentCallback in payment.controller.js
        // - so a failed/abandoned STK push never costs the landlord
        // their discount.
        loyalty_discount_id: loyaltyDiscountId,
      })
      .select()
      .single();

    if (error) throw error;

    return res.json({
      message: stkResponse
        ? 'M-Pesa prompt sent. Enter your PIN to complete renewal.'
        : "We couldn't send the automatic M-Pesa prompt right now - pay manually below instead.",
      checkoutRequestId: stkResponse ? stkResponse.CheckoutRequestID : null,
      amountDue: totalCost,
      subscriptionPaymentId: subPayment.id,
      stkFailed: !stkResponse,
      stkFailureReason: stkResponse ? undefined : stkFailureReason,
    });
  } catch (err) {
    logger.error('[subscription] renewSubscription error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to start renewal.' });
  }
}

// ---------------------------------------------------------------------
// ADD UNITS MID-PERIOD (blueprint 9.3 - prorated cost via STK)
// ---------------------------------------------------------------------
async function addUnitsMidPeriod(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { additionalUnits } = req.body;

    if (!additionalUnits || additionalUnits < 1) {
      return res.status(400).json({ error: 'additionalUnits must be at least 1.' });
    }

    const { data: landlord, error: fetchError } = await supabase.from('landlords').select('*').eq('id', landlordId).single();
    if (fetchError || !landlord) return res.status(404).json({ error: 'Landlord not found.' });

    if (!landlord.subscription_expires_at) {
      return res.status(400).json({ error: 'No active subscription period found to prorate against.' });
    }

    const remainingMs = new Date(landlord.subscription_expires_at).getTime() - Date.now();
    const remainingMonths = Math.max(1, Math.ceil(remainingMs / (1000 * 60 * 60 * 24 * 30)));

    const cost = await calculateAddUnitsCost(additionalUnits, remainingMonths, landlordId);

    const stkResponse = await initiateSTKPush({
      phoneNumber: landlord.phone,
      amount: cost,
      accountReference: `RENTAPAY-ADDUNITS-${landlordId.slice(0, 8)}`,
      transactionDesc: 'Add units to RentaPay subscription',
    });

    return res.json({
      message: 'M-Pesa prompt sent to pay for additional units.',
      proratedCost: cost,
      remainingMonths,
      checkoutRequestId: stkResponse.CheckoutRequestID,
    });
  } catch (err) {
    logger.error('[subscription] addUnitsMidPeriod error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to process add-units request.' });
  }
}

/**
 * Confirms additional units after STK payment succeeds. In a full
 * implementation this would be triggered from the Daraja callback
 * (similar pattern to processSubscriptionPaymentCallback) rather than
 * called directly - left here as the function the callback should
 * invoke once that account_reference pattern is added.
 */
async function confirmAddUnits(landlordId, additionalUnits) {
  const { data: landlord, error } = await supabase.from('landlords').select('unit_limit').eq('id', landlordId).single();
  if (error || !landlord) throw new Error('Landlord not found');

  await supabase.from('landlords').update({ unit_limit: landlord.unit_limit + additionalUnits }).eq('id', landlordId);
  logActivity({ actorType: 'system', action: 'units_added_to_subscription', targetType: 'landlord', targetId: landlordId, metadata: { additionalUnits } });
}

// ---------------------------------------------------------------------
// GET SUBSCRIPTION STATUS (countdown display - blueprint 9.4, 11.1)
// ---------------------------------------------------------------------
async function getSubscriptionStatus(req, res) {
  try {
    const landlordId = req.user.role === 'admin' ? req.params.landlordId : effectiveLandlordId(req);

    const { data: landlord, error } = await supabase
      .from('landlords')
      .select('subscription_plan, subscription_status, subscription_started_at, subscription_expires_at, unit_limit')
      .eq('id', landlordId)
      .single();

    if (error || !landlord) return res.status(404).json({ error: 'Landlord not found.' });

    // FIX (direct request: apartments must be independent - "under no
    // circumstance should they show the same number [of units]"):
    // this endpoint used to ALWAYS answer with the landlord row's
    // pooled unit_limit/expiry, no matter which property the caller
    // was actually asking about. Every screen that checks "am I at my
    // unit limit yet" (Add Unit, the subscription banner, etc.) reads
    // from here, so a property that has its OWN independent
    // unit_limit (see add-per-property-subscriptions.sql) was still
    // being measured against the landlord-wide total - a landlord's
    // second apartment could get blocked by units used up on their
    // first apartment, and vice versa.
    //
    // Same rule as unit.controller.js's createUnit: if the requested
    // property has its own unit_limit set, its own fields are the
    // answer. Only the landlord's original/first property (never
    // given its own clock) falls back to the landlord row.
    let responseData = landlord;
    let scopedToPropertyId = null;
    if (req.query.propertyId && req.query.propertyId !== 'unassigned') {
      const { data: property } = await supabase
        .from('properties')
        .select('subscription_status, subscription_started_at, subscription_expires_at, unit_limit, landlord_id')
        .eq('id', req.query.propertyId)
        .maybeSingle();
      if (property && property.landlord_id === landlordId && property.unit_limit != null) {
        responseData = {
          // properties don't have their own plan-name column - that's
          // purely cosmetic (label text), so it's fine to keep showing
          // the landlord's plan name here even for an independently-
          // clocked property.
          subscription_plan: landlord.subscription_plan,
          subscription_status: property.subscription_status,
          subscription_started_at: property.subscription_started_at,
          subscription_expires_at: property.subscription_expires_at,
          unit_limit: property.unit_limit,
        };
        scopedToPropertyId = req.query.propertyId;
      }
    }

    let daysLeft = null;
    if (responseData.subscription_expires_at) {
      const diffMs = new Date(responseData.subscription_expires_at).getTime() - Date.now();
      daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    }

    return res.json({ ...responseData, daysLeft, scopedToPropertyId });
  } catch (err) {
    logger.error('[subscription] getSubscriptionStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch subscription status.' });
  }
}

// ---------------------------------------------------------------------
// LOYALTY DISCOUNT REMINDER POPUP (direct request: "should be sending
// such landlords whose subscription is not ended that there is a
// discount to their next renewal... reminding them... should be in
// app and popup not email"). Polled by
// LoyaltyDiscountReminderPopup.jsx, same pattern as the tenant-rating
// reminder popup - the actual notify() call already fired once at
// grant time (see landlordLoyalty.service.js's bulkGrantLoyaltyDiscount);
// this is the recurring, dismissible on-screen nudge for as long as
// the discount sits unused.
// ---------------------------------------------------------------------
async function getLoyaltyDiscountReminder(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);

    const { data: landlord, error } = await supabase
      .from('landlords')
      .select('subscription_status')
      .eq('id', landlordId)
      .maybeSingle();
    if (error || !landlord) return res.status(404).json({ error: 'Landlord not found.' });

    // Only surface the reminder while there's actually a subscription
    // still running to renew - a landlord whose account has never been
    // activated ('pending') or has already lapsed ('expired') gets the
    // renewal/reactivation flow itself, not a "your renewal has a
    // discount" nudge.
    if (!['active', 'suspended'].includes(landlord.subscription_status)) {
      return res.json({ reminder: null });
    }

    const reminder = await loyaltyService.getReminderForLandlord(landlordId);
    return res.json({ reminder });
  } catch (err) {
    logger.error('[subscription] getLoyaltyDiscountReminder error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch loyalty discount reminder.' });
  }
}

async function snoozeLoyaltyDiscountReminder(req, res) {
  try {
    const { id } = req.params;
    const { mode } = req.body; // 'later' | 'not_today'
    await loyaltyService.snoozeReminder(id, mode);
    return res.json({ message: 'Snoozed.' });
  } catch (err) {
    logger.error('[subscription] snoozeLoyaltyDiscountReminder error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to snooze reminder.' });
  }
}

// ---------------------------------------------------------------------
// SUBSCRIPTION QUOTE (P1 support: "Validate manual payment amounts
// against the discounted price"). Lets the frontend show the true,
// discount-inclusive expected total - the exact same number
// calculateSubscriptionCost() would produce for an STK renewal -
// BEFORE the landlord ever types an amount into the manual-payment
// form, instead of the frontend guessing with its own hardcoded
// rate/discount constants (which drift the moment an admin changes
// pricing or a loyalty discount is granted/consumed).
// ---------------------------------------------------------------------
async function getSubscriptionQuote(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const unitsCount = Number(req.query.unitsCount);
    const periodMonths = Number(req.query.periodMonths);

    if (!Number.isFinite(unitsCount) || unitsCount < 1) {
      return res.status(400).json({ error: 'unitsCount must be a whole number, 1 or more.' });
    }
    if (!Number.isFinite(periodMonths) || periodMonths < 1) {
      return res.status(400).json({ error: 'periodMonths must be a whole number, 1 or more.' });
    }

    const quote = await calculateSubscriptionCost(unitsCount, periodMonths, landlordId);
    return res.json(quote);
  } catch (err) {
    logger.error('[subscription] getSubscriptionQuote error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to calculate subscription cost.' });
  }
}

module.exports = {
  renewSubscription,
  addUnitsMidPeriod,
  confirmAddUnits,
  getSubscriptionStatus,
  getSubscriptionQuote,
  getLoyaltyDiscountReminder,
  snoozeLoyaltyDiscountReminder,
};
