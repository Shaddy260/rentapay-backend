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

// ---------------------------------------------------------------------
// RENEW SUBSCRIPTION (blueprint 9.4 + 11.2: "Renew subscription via M-Pesa")
// ---------------------------------------------------------------------
async function renewSubscription(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { plan, periodMonths, unitsCount } = req.body;

    const { data: landlord, error: fetchError } = await supabase.from('landlords').select('*').eq('id', landlordId).single();
    if (fetchError || !landlord) return res.status(404).json({ error: 'Landlord not found.' });

    const { totalCost } = calculateSubscriptionCost(Number(unitsCount), Number(periodMonths));

    const stkResponse = await initiateSTKPush({
      phoneNumber: landlord.phone,
      amount: totalCost,
      accountReference: `RENTAPAY-RENEW-${landlordId.slice(0, 8)}`,
      transactionDesc: 'RentaPay subscription renewal',
    });

    const { data: subPayment, error } = await supabase
      .from('subscription_payments')
      .insert({
        landlord_id: landlordId,
        plan,
        period_months: periodMonths,
        units_count: unitsCount,
        amount: totalCost,
        mpesa_checkout_request_id: stkResponse.CheckoutRequestID,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    return res.json({
      message: 'M-Pesa prompt sent. Enter your PIN to complete renewal.',
      checkoutRequestId: stkResponse.CheckoutRequestID,
      amountDue: totalCost,
      subscriptionPaymentId: subPayment.id,
    });
  } catch (err) {
    console.error('[subscription] renewSubscription error:', err.message);
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

    const cost = calculateAddUnitsCost(additionalUnits, remainingMonths);

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
    console.error('[subscription] addUnitsMidPeriod error:', err.message);
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
    console.error('[subscription] getSubscriptionStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch subscription status.' });
  }
}

module.exports = { renewSubscription, addUnitsMidPeriod, confirmAddUnits, getSubscriptionStatus };
