// src/controllers/payment.controller.js
const { effectiveLandlordId } = require('../middleware/auth.middleware');
//
// Implements blueprint section 5 (Payment System) and section 9.4's
// renewal flow on the landlord-subscription side. This is the most
// critical file in the system - every rent payment flows through here.

const supabase = require('../config/supabase');
const { initiateSTKPush, querySTKPushStatus } = require('../services/daraja.service');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const { notify } = require('../services/notify.service');
const templates = require('../services/notificationTemplates');
const { logActivity } = require('../services/activityLog.service');
const { activateLandlordAfterPayment } = require('./auth.controller');
const { processPropertyPaymentCallback } = require('./property.controller');
const { processScoutCountyPaymentCallback } = require('./scout.controller');
const { normalizePhone } = require('../utils/phone');
const { applyPaymentToBalance, buildPrepaymentSummary } = require('../utils/prepayment');
const { validatePositiveAmount } = require('../utils/validateAmount');
const { applyUnitLimitChange } = require('../utils/unitLimitEnforcement');

// ---------------------------------------------------------------------
// INITIATE STK PUSH FOR RENT (blueprint 5.2 - primary payment method)
// ---------------------------------------------------------------------
async function initiateRentSTKPush(req, res) {
  try {
    const tenantId = req.user.id;
    const { amount } = req.body;

    const validatedAmount = validatePositiveAmount(amount);
    if (validatedAmount === null) {
      return res.status(400).json({ error: 'A valid amount is required.' });
    }

    const { data: tenant, error } = await supabase.from('tenants').select('*, units(unit_payment_code)').eq('id', tenantId).single();
    if (error || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const stkResponse = await initiateSTKPush({
      phoneNumber: tenant.primary_phone,
      amount: validatedAmount,
      accountReference: tenant.units.unit_payment_code,
      transactionDesc: 'Rent payment',
    });

    const { data: payment, error: insertError } = await supabase
      .from('payments')
      .insert({
        tenant_id: tenantId,
        unit_id: tenant.unit_id,
        landlord_id: tenant.landlord_id,
        amount: validatedAmount,
        payment_method: 'stk_push',
        mpesa_checkout_request_id: stkResponse.CheckoutRequestID,
        status: 'pending',
      })
      .select()
      .single();

    if (insertError) throw insertError;

    return res.json({
      message: 'STK push sent. Enter your M-Pesa PIN to complete payment.',
      checkoutRequestId: stkResponse.CheckoutRequestID,
      paymentId: payment.id,
    });
  } catch (err) {
    console.error('[payment] initiateRentSTKPush error:', err.message);
    return res.status(500).json({ error: 'Failed to initiate payment.' });
  }
}

// ---------------------------------------------------------------------
// SELF-HEALING PAYMENT STATUS CHECK - THE FIX for "signed up, paid,
// but never got the verification OTP" (and the tenant-side equivalent
// for rent payments).
//
// The registration flow's "I've paid" step used to just move the
// person straight to the OTP screen, TRUSTING that Safaricom's
// callback had already reached handleSTKCallback() below and
// activated the account. In practice that callback can be late,
// never arrive at all (DARAJA_CALLBACK_URL unreachable - wrong ngrok
// URL, tunnel not running, server briefly down when Safaricom tried),
// or - in local dev - simply never exist unless someone manually hits
// /api/dev/simulate-payment-success. Any of those leaves
// subscription_status stuck on 'pending' with no OTP ever generated,
// and verifyOTP() then fails with a confusing "Invalid OTP" even
// though the person did everything right.
//
// This endpoint lets the frontend POLL for the real state instead of
// assuming it. If our own row is still 'pending', it actively asks
// Safaricom directly (querySTKPushStatus) rather than just waiting
// for a webhook that may never come - the same self-healing pattern
// real M-Pesa integrations use. If Safaricom confirms success, this
// completes the activation itself, right here, without waiting on the
// callback at all.
// ---------------------------------------------------------------------
async function checkSubscriptionPaymentStatus(req, res) {
  try {
    const { checkoutRequestId } = req.params;
    if (!checkoutRequestId) return res.status(400).json({ error: 'checkoutRequestId is required.' });

    const { data: subPayment, error } = await supabase
      .from('subscription_payments')
      .select('*, landlords(*)')
      .eq('mpesa_checkout_request_id', checkoutRequestId)
      .maybeSingle();

    if (error || !subPayment) return res.status(404).json({ error: 'No payment found for that checkout request.' });

    if (subPayment.status === 'completed') {
      return res.json({ status: 'completed', landlordId: subPayment.landlord_id });
    }
    if (subPayment.status === 'failed') {
      return res.json({ status: 'failed' });
    }

    // Still pending in our own records - ask Safaricom directly rather
    // than keep waiting for a webhook that might not be coming.
    let queryResult;
    try {
      queryResult = await querySTKPushStatus(checkoutRequestId);
    } catch (queryErr) {
      // Couldn't reach Safaricom to check either - still genuinely
      // "pending" from the frontend's point of view, not an error the
      // person did anything wrong to cause. Let them keep polling.
      console.warn('[payment] checkSubscriptionPaymentStatus: querySTKPushStatus failed, still pending:', queryErr.message);
      return res.json({ status: 'pending' });
    }

    const resultCode = Number(queryResult.ResultCode);
    if (resultCode === 0) {
      // Confirmed by Safaricom - complete activation now instead of
      // waiting for the callback (which may still arrive later too;
      // handleSTKCallback's idempotency guard makes that safe).
      await processSubscriptionPaymentCallback(subPayment, 0, null);
      return res.json({ status: 'completed', landlordId: subPayment.landlord_id });
    }

    // Safaricom has a real answer and it's not success (e.g. 1032 =
    // cancelled by user, 1037 = timeout/no PIN entered yet - some
    // sandboxes return this while still genuinely in-flight, so it's
    // treated as "keep polling" rather than an immediate failure).
    if (!Number.isNaN(resultCode) && resultCode !== 1037) {
      await supabase.from('subscription_payments').update({ status: 'failed' }).eq('id', subPayment.id);
      return res.json({ status: 'failed', reason: queryResult.ResultDesc });
    }

    return res.json({ status: 'pending' });
  } catch (err) {
    console.error('[payment] checkSubscriptionPaymentStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to check payment status.' });
  }
}

// Same self-heal pattern for a tenant's rent STK push (blueprint 5.2) -
// the tenant portal's "I've completed the payment" button currently
// just re-fetches the balance and hopes the callback already landed;
// this gives it something authoritative to poll instead.
async function checkRentPaymentStatus(req, res) {
  try {
    const { checkoutRequestId } = req.params;
    if (!checkoutRequestId) return res.status(400).json({ error: 'checkoutRequestId is required.' });

    const { data: payment, error } = await supabase
      .from('payments')
      .select('*, tenants(*), units(unit_name, rent_amount, property_id)')
      .eq('mpesa_checkout_request_id', checkoutRequestId)
      .maybeSingle();

    if (error || !payment) return res.status(404).json({ error: 'No payment found for that checkout request.' });
    if (payment.tenant_id !== req.user.id) return res.status(403).json({ error: 'Not your payment.' });

    if (payment.status === 'completed') return res.json({ status: 'completed' });
    if (payment.status === 'failed') return res.json({ status: 'failed' });

    let queryResult;
    try {
      queryResult = await querySTKPushStatus(checkoutRequestId);
    } catch (queryErr) {
      console.warn('[payment] checkRentPaymentStatus: querySTKPushStatus failed, still pending:', queryErr.message);
      return res.json({ status: 'pending' });
    }

    const resultCode = Number(queryResult.ResultCode);
    if (resultCode === 0) {
      await processRentPaymentCallback(payment, 0, null);
      return res.json({ status: 'completed' });
    }
    if (!Number.isNaN(resultCode) && resultCode !== 1037) {
      await supabase.from('payments').update({ status: 'failed' }).eq('id', payment.id);
      return res.json({ status: 'failed', reason: queryResult.ResultDesc });
    }

    return res.json({ status: 'pending' });
  } catch (err) {
    console.error('[payment] checkRentPaymentStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to check payment status.' });
  }
}

// ---------------------------------------------------------------------
// DARAJA CALLBACK - the webhook Safaricom hits after STK push completes.
// This single endpoint handles BOTH rent payments and landlord
// subscription payments, distinguished by which payments table row
// matches the CheckoutRequestID (blueprint 5.2 + 9.4 flows).
// ---------------------------------------------------------------------
async function handleSTKCallback(req, res) {
  // IMPORTANT: Always respond 200 to Safaricom quickly, even on internal
  // errors, otherwise Safaricom will retry the same callback repeatedly.
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const { CheckoutRequestID, ResultCode, CallbackMetadata } = callback;

    // Check rent payments first
    const { data: rentPayment } = await supabase
      .from('payments')
      .select('*, tenants(*), units(unit_name, rent_amount, property_id)')
      .eq('mpesa_checkout_request_id', CheckoutRequestID)
      .maybeSingle();

    if (rentPayment) {
      if (rentPayment.status === 'completed') {
        // Safaricom retries callbacks; the self-heal poll below can
        // also race with a real callback landing moments later.
        // Re-running processRentPaymentCallback on an already-
        // completed payment would apply the SAME payment to the
        // tenant's balance a second time - guard against that.
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Already processed' });
      }
      await processRentPaymentCallback(rentPayment, ResultCode, CallbackMetadata);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    // Otherwise check landlord subscription payments
    const { data: subPayment } = await supabase
      .from('subscription_payments')
      .select('*, landlords(*)')
      .eq('mpesa_checkout_request_id', CheckoutRequestID)
      .maybeSingle();

    if (subPayment) {
      if (subPayment.status === 'completed') {
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Already processed' });
      }
      await processSubscriptionPaymentCallback(subPayment, ResultCode, CallbackMetadata);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    // Otherwise check paid "add a property" requests
    const { data: propPayment } = await supabase
      .from('property_payments')
      .select('*')
      .eq('mpesa_checkout_request_id', CheckoutRequestID)
      .maybeSingle();

    if (propPayment) {
      if (propPayment.status === 'completed') {
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Already processed' });
      }
      await processPropertyPaymentCallback(propPayment, ResultCode);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    // Otherwise check Scout county-subscription payments (Phase 4)
    const { data: scoutPayment } = await supabase
      .from('scout_county_payments')
      .select('*')
      .eq('mpesa_checkout_request_id', CheckoutRequestID)
      .maybeSingle();

    if (scoutPayment) {
      if (scoutPayment.status === 'completed') {
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Already processed' });
      }
      await processScoutCountyPaymentCallback(scoutPayment, ResultCode, CallbackMetadata);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    console.warn('[payment] Callback received for unknown CheckoutRequestID:', CheckoutRequestID);
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('[payment] handleSTKCallback error:', err.message);
    // Still 200 - we don't want Safaricom retry storms over our internal bugs.
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
}

// ---------------------------------------------------------------------
// FIX (direct request: "check whether scouts receive mpesa popups...
// make sure its just exactly the same trail as the landlords"). Scouts
// DO get the same STK push as landlords (initiateSTKPush is called by
// scout.controller.js's subscribeScoutCounties exactly like a
// landlord's renewSubscription), but there was never a status-poll
// endpoint for it - only the landlord side
// (checkSubscriptionPaymentStatus above) could self-heal by asking
// Safaricom directly. That's why the Scout portal's "Check your
// phone" screen just sat there with no way to know the payment had
// actually gone through except a manual page refresh. Exact mirror of
// checkSubscriptionPaymentStatus, just pointed at
// scout_county_payments instead of subscription_payments.
// ---------------------------------------------------------------------
async function checkScoutCountyPaymentStatus(req, res) {
  try {
    const { checkoutRequestId } = req.params;
    if (!checkoutRequestId) return res.status(400).json({ error: 'checkoutRequestId is required.' });

    const { data: scoutPayment, error } = await supabase
      .from('scout_county_payments')
      .select('*')
      .eq('mpesa_checkout_request_id', checkoutRequestId)
      .maybeSingle();

    if (error || !scoutPayment) return res.status(404).json({ error: 'No payment found for that checkout request.' });

    if (scoutPayment.status === 'completed') {
      return res.json({ status: 'completed' });
    }
    if (scoutPayment.status === 'failed') {
      return res.json({ status: 'failed' });
    }

    let queryResult;
    try {
      queryResult = await querySTKPushStatus(checkoutRequestId);
    } catch (queryErr) {
      console.warn('[payment] checkScoutCountyPaymentStatus: querySTKPushStatus failed, still pending:', queryErr.message);
      return res.json({ status: 'pending' });
    }

    const resultCode = Number(queryResult.ResultCode);
    if (resultCode === 0) {
      await processScoutCountyPaymentCallback(scoutPayment, 0, null);
      return res.json({ status: 'completed' });
    }

    if (!Number.isNaN(resultCode) && resultCode !== 1037) {
      await supabase.from('scout_county_payments').update({ status: 'failed' }).eq('id', scoutPayment.id);
      return res.json({ status: 'failed', reason: queryResult.ResultDesc });
    }

    return res.json({ status: 'pending' });
  } catch (err) {
    console.error('[payment] checkScoutCountyPaymentStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to check payment status.' });
  }
}

function extractMetadataValue(callbackMetadata, name) {
  const item = callbackMetadata?.Item?.find((i) => i.Name === name);
  return item ? item.Value : null;
}

async function processRentPaymentCallback(payment, resultCode, callbackMetadata) {
  if (resultCode !== 0) {
    await supabase.from('payments').update({ status: 'failed' }).eq('id', payment.id);
    return;
  }

  const mpesaReceiptNumber = extractMetadataValue(callbackMetadata, 'MpesaReceiptNumber');
  const transactionDate = extractMetadataValue(callbackMetadata, 'TransactionDate');
  const phoneNumber = extractMetadataValue(callbackMetadata, 'PhoneNumber') || payment.mpesa_phone || payment.tenants?.primary_phone;
  // The STK Push Query endpoint (used by the self-heal poll in
  // checkRentPaymentStatus when no webhook has arrived) doesn't return
  // CallbackMetadata items the way the real webhook callback does -
  // fall back to what the tenant actually requested to pay, which is
  // already on the payment row itself.
  const amountPaid = extractMetadataValue(callbackMetadata, 'Amount') ?? payment.amount;

  await supabase
    .from('payments')
    .update({
      status: 'completed',
      mpesa_transaction_id: mpesaReceiptNumber,
      mpesa_phone: phoneNumber ? String(phoneNumber) : null,
      paid_at: new Date().toISOString(),
    })
    .eq('id', payment.id);

  const tenant = payment.tenants;
  const unit = payment.units;
  const rentAmount = Number(tenant.rent_override || unit.rent_amount || 0);

  // THE FIX: balance is now measured against the tenant's actual
  // running ledger (tenant.balance_due - the real total they owe or
  // are ahead by right now), never against payment.amount (which is
  // just this transaction's own requested amount - comparing a
  // payment to itself could never detect a real partial or
  // overpayment, which is why balances previously looked "stuck").
  const balanceBeforePayment = Number(tenant.balance_due || 0);
  const isPartial = balanceBeforePayment > 0 && Number(amountPaid) < balanceBeforePayment;
  const newBalance = applyPaymentToBalance(balanceBeforePayment, Number(amountPaid));
  const overpaidAmount = newBalance < 0 ? Math.abs(newBalance) : 0;

  if (isPartial) {
    await supabase.from('payments').update({ is_partial: true }).eq('id', payment.id);
  }

  const tenantUpdate = { balance_due: newBalance };
  const dueDay = tenant.due_day_of_month || unit.due_day_of_month;
  const today = new Date();
  const nextCycleDueDate = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
  const prepaymentInfo = buildPrepaymentSummary(newBalance, rentAmount, nextCycleDueDate);

  await supabase.from('tenants').update(tenantUpdate).eq('id', tenant.id);

  // Notify tenant (receipt) and landlord (dashboard alert) - both go
  // to SMS and the in-portal inbox now.
  await notify('tenant', tenant.id, tenant.primary_phone, templates.paymentReceipt(tenant.full_name, amountPaid, mpesaReceiptNumber, transactionDate), { category: 'account', title: 'Payment Receipt' });

  // FIX (direct request): tell the tenant clearly they've paid ahead
  // and by how much, and exactly what's owed next - due on the real
  // date the landlord set (dueDayOfMonth), never an invented
  // "covered through" projection or a countdown.
  if (overpaidAmount > 0 && prepaymentInfo?.isAhead) {
    const nextAmountWording =
      prepaymentInfo.nextPaymentAmount > 0
        ? `Next month you'll owe KES ${prepaymentInfo.nextPaymentAmount.toLocaleString()}, due on ${prepaymentInfo.nextPaymentDueDate.toLocaleDateString('en-GB')}.`
        : `Next month is already fully covered too.`;
    await notify(
      'tenant',
      tenant.id,
      tenant.primary_phone,
      `You've paid ahead by KES ${overpaidAmount.toLocaleString()}. ${nextAmountWording}`,
      { category: 'account', title: 'Payment Ahead of Schedule' }
    );
  }

  const { data: landlord } = await supabase.from('landlords').select('phone').eq('id', payment.landlord_id).single();
  if (landlord) {
    const msg = isPartial
      ? templates.partialPaymentReceived(tenant.full_name, unit.unit_name, amountPaid, Math.max(newBalance, 0))
      : templates.tenantPaid(tenant.full_name, unit.unit_name, amountPaid);
    await notify('landlord', payment.landlord_id, landlord.phone, msg, { category: 'account', title: 'Payment Received', propertyId: unit?.property_id || null });
  }

  logActivity({
    actorType: 'system',
    action: 'rent_payment_completed',
    targetType: 'tenant',
    targetId: tenant.id,
    metadata: { amountPaid, mpesaReceiptNumber, isPartial, overpaidAmount, balanceBefore: balanceBeforePayment, balanceAfter: newBalance },
  });
}

async function processSubscriptionPaymentCallback(subPayment, resultCode, callbackMetadata) {
  if (resultCode !== 0) {
    await supabase.from('subscription_payments').update({ status: 'failed' }).eq('id', subPayment.id);
    return;
  }

  const mpesaReceiptNumber = extractMetadataValue(callbackMetadata, 'MpesaReceiptNumber');
  const phoneNumber = extractMetadataValue(callbackMetadata, 'PhoneNumber');

  await supabase
    .from('subscription_payments')
    .update({
      status: 'completed',
      mpesa_transaction_id: mpesaReceiptNumber,
      mpesa_phone: phoneNumber ? String(phoneNumber) : null,
      paid_at: new Date().toISOString(),
    })
    .eq('id', subPayment.id);

  const landlord = subPayment.landlords;
  if (!landlord) {
    // Should be impossible given the foreign key + join in
    // handleSTKCallback's select('*, landlords(*)'), but if it ever
    // happens (e.g. landlord row deleted between insert and callback,
    // or a join/alias mismatch), fail loudly instead of crashing on
    // landlord.subscription_status below with an opaque TypeError.
    console.error(
      `[payment] CRITICAL: subscription_payments row ${subPayment.id} has no joined landlord (landlord_id=${subPayment.landlord_id}). Cannot activate account.`
    );
    return;
  }

  const isFirstPayment = landlord.subscription_status === 'pending';

  if (isFirstPayment) {
    // First-ever payment completes registration (blueprint 3.1)
    await activateLandlordAfterPayment(landlord.id, subPayment.period_months);
  } else {
    // Renewal (blueprint 9.4 / 11.2): extend expiry by the period paid for
    let currentExpiry = landlord.subscription_expires_at ? new Date(landlord.subscription_expires_at) : new Date();
    if (currentExpiry < new Date()) currentExpiry = new Date();
    currentExpiry.setMonth(currentExpiry.getMonth() + subPayment.period_months);

    await supabase
      .from('landlords')
      .update({
        subscription_expires_at: currentExpiry.toISOString(),
        subscription_status: 'active',
        subscription_plan: subPayment.plan,
        unit_limit: subPayment.units_count,
        // FIX (subscription progress bar "not shrinking properly"):
        // periodMonths was never updated here. The dashboard bar
        // computes daysLeft / (periodMonths * 30) - without this, a
        // landlord who renewed for e.g. 2 months kept the OLD
        // periodMonths (often 1, from original signup) as the
        // divisor, so the bar stayed pinned near 100% then collapsed
        // abruptly instead of shrinking smoothly across the real
        // length just paid for.
        subscription_period_months: subPayment.period_months,
        subscription_started_at: new Date().toISOString(),
      })
      .eq('id', landlord.id);

    // Same freeze/unfreeze + tenant-archive-safety rules as the admin
    // path (see unitLimitEnforcement.js) - a landlord renewing with
    // FEWER units than they currently have never deletes a tenant, it
    // archives them and greys out the extra unit(s), preferring empty
    // units first. Renewing back up unfreezes automatically.
    await applyUnitLimitChange({ landlordId: landlord.id, newLimit: Number(subPayment.units_count), actorType: 'system', actorId: landlord.id });

    if (landlord.email) {
      await sendEmail(
        landlord.email,
        'Your RentaPay subscription has been renewed',
        wrapEmailHtml(templates.subscriptionRenewed(currentExpiry.toLocaleDateString('en-GB')))
      );
    }
  }

  logActivity({ actorType: 'system', action: 'subscription_payment_completed', targetType: 'landlord', targetId: landlord.id, metadata: { mpesaReceiptNumber } });
}

// ---------------------------------------------------------------------
// PAYBILL FLOW - tenant submits proof of a manual M-Pesa payment made
// directly to their landlord's own Till/Paybill/Phone (NOT via Daraja/
// STK push - there is no Safaricom API involvement in this flow at
// all). This used to be a 501 stub waiting on the Daraja Transaction
// Status API; that dependency is gone now - the tenant's submission
// just goes into pending_payment_confirmations for their landlord or
// property manager to manually confirm or reject (see
// pendingPaymentConfirmation.controller.js for that side).
// ---------------------------------------------------------------------
async function submitPaybillTransaction(req, res) {
  try {
    const tenantId = req.user.id;
    const { transactionCode, amountPaid, mpesaPayerName, mpesaPayerPhone, mpesaSmsTimestamp } = req.body;

    if (!transactionCode || amountPaid == null || !mpesaPayerName || !mpesaPayerPhone || !mpesaSmsTimestamp) {
      return res.status(400).json({ error: 'transactionCode, amountPaid, mpesaPayerName, mpesaPayerPhone, and mpesaSmsTimestamp are required.' });
    }
    const normalizedPayerPhone = normalizePhone(mpesaPayerPhone);
    if (!normalizedPayerPhone) {
      return res.status(400).json({ error: 'mpesaPayerPhone must be a valid phone number.' });
    }
    const validatedAmountPaid = validatePositiveAmount(amountPaid);
    if (validatedAmountPaid === null) {
      return res.status(400).json({ error: 'amountPaid must be a valid positive number.' });
    }

    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('id, unit_id, landlord_id, units(property_id)')
      .eq('id', tenantId)
      .single();
    if (tenantErr || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    // Normalize the same way the landlord will see it, so a duplicate
    // typed with different spacing/casing still matches.
    const normalizedCode = String(transactionCode).trim().toUpperCase();

    // Check for an existing CONFIRMED record with the same code - this
    // is a fraud signal, not an automatic rejection. A human (the
    // landlord/manager) still needs to look at it and decide; we just
    // flag it prominently via duplicate_of so it can't slip through
    // unnoticed.
    const { data: existingConfirmed } = await supabase
      .from('pending_payment_confirmations')
      .select('id')
      .eq('transaction_code', normalizedCode)
      .eq('status', 'confirmed')
      .order('confirmed_or_rejected_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // "When a tenant re-submits after a rejection, it should land in
    // the landlord's portal as a priority - Resubmitted Request." If
    // this tenant's most recent submission (for this unit) was
    // rejected and hasn't been superseded by a later pending/confirmed
    // one yet, link this new submission back to it.
    const { data: mostRecent } = await supabase
      .from('pending_payment_confirmations')
      .select('id, status')
      .eq('tenant_id', tenantId)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const isResubmission = mostRecent?.status === 'rejected';

    const { data: record, error: insertErr } = await supabase
      .from('pending_payment_confirmations')
      .insert({
        tenant_id: tenantId,
        unit_id: tenant.unit_id,
        landlord_id: tenant.landlord_id,
        property_id: tenant.units?.property_id || null,
        transaction_code: normalizedCode,
        amount_paid: validatedAmountPaid,
        mpesa_payer_name: String(mpesaPayerName).trim(),
        mpesa_payer_phone: normalizedPayerPhone,
        mpesa_sms_timestamp: mpesaSmsTimestamp,
        status: 'pending',
        duplicate_of: existingConfirmed ? existingConfirmed.id : null,
        resubmission_of: isResubmission ? mostRecent.id : null,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // Let the landlord AND every manager/caretaker on this account
    // know something is waiting on them - not just the landlord (they
    // may not be the one who checks the app daily).
    //
    // Deliberately NOT awaited: notify() fans out to SMS, the in-app
    // inbox, and (for urgent items like this) a real push
    // notification - any one of which can be slow or hang on a flaky
    // network. The tenant's payment submission must succeed and
    // respond immediately regardless of how long notifying the
    // landlord/managers takes; a stuck notification should never turn
    // into a 504 for the person submitting a payment.
    (async () => {
      try {
        const notifyMessage = isResubmission
          ? `A tenant RE-SUBMITTED a Paybill payment of KES ${validatedAmountPaid.toLocaleString()} (ref ${normalizedCode}) after a previous rejection - awaiting your confirmation.`
          : `A tenant submitted a Paybill payment of KES ${validatedAmountPaid.toLocaleString()} (ref ${normalizedCode}) awaiting your confirmation.`;
        const notifyTitle = isResubmission ? 'Resubmitted Payment Awaiting Confirmation' : 'Payment Awaiting Confirmation';

        const { data: landlord } = await supabase.from('landlords').select('phone').eq('id', tenant.landlord_id).maybeSingle();
        if (landlord) {
          await notify('landlord', tenant.landlord_id, landlord.phone, notifyMessage, { category: 'account', title: notifyTitle, urgent: true, propertyId: tenant.units?.property_id || null });
        }

        const { data: staff } = await supabase.from('property_managers').select('id, phone').eq('landlord_id', tenant.landlord_id);
        for (const member of staff || []) {
          await notify('manager', member.id, member.phone, notifyMessage, { category: 'account', title: notifyTitle, urgent: true, propertyId: tenant.units?.property_id || null });
        }
      } catch (notifyErr) {
        console.error('[payment] submitPaybillTransaction: notify failed (non-blocking):', notifyErr.message);
      }
    })();

    logActivity({
      actorType: 'tenant',
      actorId: tenantId,
      action: 'paybill_payment_submitted',
      targetType: 'pending_payment_confirmation',
      targetId: record.id,
      metadata: { transactionCode: normalizedCode, amountPaid: validatedAmountPaid, isDuplicate: !!existingConfirmed, isResubmission },
    });

    return res.status(201).json({
      message: existingConfirmed
        ? 'This transaction code was already used for a previous confirmed payment and cannot be reused. Your landlord has been notified to look into it - please contact them if you believe this is a mistake.'
        : 'Submitted, waiting for approval.',
      isDuplicate: !!existingConfirmed,
      confirmation: record,
    });
  } catch (err) {
    console.error('[payment] submitPaybillTransaction error:', err.message);
    return res.status(500).json({ error: 'Failed to submit transaction.' });
  }
}


// ---------------------------------------------------------------------
// MANUAL PAYMENT RECORDING (blueprint 5.6 - landlord records cash/3rd party)
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// GET /api/payments/my-latest-confirmation (tenant only)
//
// FIX ("tenant still shows 'awaiting confirmation' even after the
// landlord rejected it"): the tenant portal used to infer confirmation
// by watching for a matching row to appear in `payments` (which only
// happens on CONFIRM, never on REJECT), so a rejection was invisible
// to the tenant until they manually refreshed and happened to notice
// nothing changed. This returns the tenant's own most recent
// submission with its real status, so the portal can show a proper
// rejection banner (with reason + resubmit) the moment it happens.
// ---------------------------------------------------------------------
async function getMyLatestPaybillConfirmation(req, res) {
  try {
    const tenantId = req.user.id;
    const { data, error } = await supabase
      .from('pending_payment_confirmations')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return res.json({ confirmation: data || null });
  } catch (err) {
    console.error('[payment] getMyLatestPaybillConfirmation error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch your payment status.' });
  }
}

async function recordManualPayment(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { tenantId, amount, paymentDate, mpesaReference, paidBy, note } = req.body;

    if (!tenantId || !amount || !paymentDate) {
      return res.status(400).json({ error: 'tenantId, amount, and paymentDate are required.' });
    }
    const validatedManualAmount = validatePositiveAmount(amount);
    if (validatedManualAmount === null) {
      return res.status(400).json({ error: 'amount must be a valid positive number.' });
    }

    const { data: tenant, error: fetchError } = await supabase.from('tenants').select('*, units(rent_amount, due_day_of_month)').eq('id', tenantId).single();
    if (fetchError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });
    if (tenant.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this tenant.' });

    const { data: payment, error } = await supabase
      .from('payments')
      .insert({
        tenant_id: tenantId,
        unit_id: tenant.unit_id,
        landlord_id: landlordId,
        amount: validatedManualAmount,
        payment_method: 'manual',
        mpesa_transaction_id: mpesaReference || null,
        status: 'completed',
        recorded_by_landlord: true,
        recorded_note: note || null,
        paid_by: paidBy || 'self',
        paid_at: paymentDate,
      })
      .select()
      .single();

    if (error) throw error;

    // Same single-ledger update as the STK callback path
    // (processRentPaymentCallback) - manual payments need it too,
    // since a landlord recording "tenant paid 5.5 months in cash"
    // goes through this function, not the M-Pesa callback. Uses the
    // same applyPaymentToBalance() function so the two payment paths
    // can never drift into different balance-calculation behaviour
    // again.
    const currentlyOwed = Number(tenant.balance_due) || 0;
    const amountNum = validatedManualAmount;
    const rentAmount = Number(tenant.rent_override || tenant.units.rent_amount || 0);
    const newBalance = applyPaymentToBalance(currentlyOwed, amountNum);
    const tenantUpdate = { balance_due: newBalance };
    const dueDay = tenant.due_day_of_month || tenant.units.due_day_of_month;
    const paymentDateObj = new Date(paymentDate);
    const nextCycleDueDate = new Date(paymentDateObj.getFullYear(), paymentDateObj.getMonth() + 1, dueDay);
    const prepaymentInfo = buildPrepaymentSummary(newBalance, rentAmount, nextCycleDueDate);

    await supabase.from('tenants').update(tenantUpdate).eq('id', tenantId);

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'manual_payment_recorded',
      targetType: 'tenant',
      targetId: tenantId,
      reason: note,
      metadata: { amount, mpesaReference, paidBy, balanceBefore: currentlyOwed, balanceAfter: newBalance },
    });

    return res.status(201).json({
      message: 'Manual payment recorded.',
      payment,
      prepayment: prepaymentInfo,
    });
  } catch (err) {
    console.error('[payment] recordManualPayment error:', err.message);
    return res.status(500).json({ error: 'Failed to record manual payment.' });
  }
}

// ---------------------------------------------------------------------
// LANDLORD PAYMENT HISTORY (new: full-history "Payment History" menu
// item, requested to sit in the menu and be downloadable across every
// portal - the landlord dashboard previously only had "this month").
// Optionally scoped to one property via ?propertyId, same convention
// as the rest of the landlord dashboard endpoints.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// DELETE A PAYMENT RECORD (direct request: "the landlord and manager
// should be able to delete a payment history... and when they do it
// deletes for all") - a real, permanent delete, not a per-viewer hide.
// Caretakers excluded via the route, same as every other
// money-editing action in this app (editBalance, transfer, etc).
// ---------------------------------------------------------------------
async function deletePayment(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { paymentId } = req.params;

    const { data: payment, error: fetchErr } = await supabase.from('payments').select('id, landlord_id').eq('id', paymentId).single();
    if (fetchErr || !payment) return res.status(404).json({ error: 'Payment not found.' });
    if (payment.landlord_id !== landlordId) return res.status(403).json({ error: 'This payment is not on your account.' });

    const { error } = await supabase.from('payments').delete().eq('id', paymentId);
    if (error) throw error;

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'payment_deleted',
      targetType: 'payment',
      targetId: paymentId,
    });

    return res.json({ message: 'Payment record deleted.' });
  } catch (err) {
    console.error('[payment] deletePayment error:', err.message);
    return res.status(500).json({ error: 'Failed to delete payment.' });
  }
}

async function getLandlordPaymentHistory(req, res) {
  try {
    const landlordId = req.user.role === 'admin' ? req.params.landlordId : effectiveLandlordId(req);
    const { propertyId } = req.query;

    let unitIds = null;
    if (propertyId) {
      let unitsQuery = supabase.from('units').select('id').eq('landlord_id', landlordId);
      unitsQuery = propertyId === 'unassigned' ? unitsQuery.is('property_id', null) : unitsQuery.eq('property_id', propertyId);
      const { data: unitsInProperty, error: unitsErr } = await unitsQuery;
      if (unitsErr) throw unitsErr;
      unitIds = (unitsInProperty || []).map((u) => u.id);
      if (unitIds.length === 0) return res.json({ payments: [] });
    }

    let query = supabase
      .from('payments')
      .select('id, amount, paid_at, payment_method, status, tenants(full_name), units(unit_name)')
      .eq('landlord_id', landlordId)
      .order('paid_at', { ascending: false, nullsFirst: false })
      .limit(1000);

    if (unitIds) query = query.in('unit_id', unitIds);

    const { data: payments, error } = await query;
    if (error) throw error;

    return res.json({ payments: payments || [] });
  } catch (err) {
    console.error('[payment] getLandlordPaymentHistory error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch payment history.' });
  }
}

// TENANT: download a formal PDF receipt for one of their own completed
// payments. The "Receipt" button in the tenant portal used to just
// call window.print() on the table row - this gives a real document
// they can save, matching the "landlord PDF reports" pattern already
// used for the collection summary (see pdfReport.service.js).
async function downloadReceiptPdf(req, res) {
  try {
    const { paymentId } = req.params;
    const tenantId = req.user.id;

    const { data: payment, error } = await supabase
      .from('payments')
      .select('*, tenants(full_name), units(unit_name, property_id, properties(name)), landlords(full_name)')
      .eq('id', paymentId)
      .maybeSingle();
    if (error) throw error;
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });
    if (payment.tenant_id !== tenantId) return res.status(403).json({ error: 'This is not your payment.' });
    if (payment.status !== 'completed') return res.status(400).json({ error: 'A receipt is only available for completed payments.' });

    const { generatePaymentReceiptPdf } = require('../services/pdfReport.service');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rentapay-receipt-${paymentId.slice(0, 8)}.pdf"`);

    generatePaymentReceiptPdf(res, {
      payment,
      tenantName: payment.tenants?.full_name,
      unitName: payment.units?.unit_name,
      propertyName: payment.units?.properties?.name,
      landlordName: payment.landlords?.full_name,
      generatedAt: new Date(),
    });
  } catch (err) {
    console.error('[payment] downloadReceiptPdf error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate receipt.' });
  }
}

module.exports = {
  initiateRentSTKPush,
  checkRentPaymentStatus,
  checkSubscriptionPaymentStatus,
  checkScoutCountyPaymentStatus,
  handleSTKCallback,
  submitPaybillTransaction,
  getMyLatestPaybillConfirmation,
  recordManualPayment,
  getLandlordPaymentHistory,
  deletePayment,
  downloadReceiptPdf,
};
