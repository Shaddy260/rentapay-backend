// src/controllers/payment.controller.js
const { effectiveLandlordId, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
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
const { signToken } = require('../middleware/auth.middleware');
const { blockIfSubscriptionExpired } = require('../utils/subscriptionGate');

// PERMANENT FIX (direct request: "landlord has to go through signup
// TWICE before reaching the dashboard - this keeps coming back, fix
// it for real this time"): root cause was never actually the
// double-submit races fixed elsewhere in RegisterFlow.jsx (those were
// real bugs too, but different ones) - it's that
// RegisterFlow.jsx's proceedAfterVerification() used to call
// api.login({ phone, password }) using form.password STILL SITTING IN
// REACT STATE from step 0, to get itself a session token once payment
// was confirmed. That password is deliberately never persisted to
// sessionStorage (security - see RegisterFlow.jsx's progress-persist
// effect), so it only survives as long as the tab's JS memory does.
// Manual-payment review alone can take "a few minutes to a few hours"
// (see ManualPaymentHelp.jsx), and even the STK path routinely
// involves backgrounding the tab to approve the prompt in the M-Pesa
// app - either one can trigger a mobile browser reloading/discarding
// the tab. The moment that happens, form.password resets to '', the
// auto-login silently fails (caught and only console.warn'd - see the
// old comment there), and the wizard sails on through the property/
// payment-method/units steps with NO valid token. Each of those steps
// checks for a token before calling its backend endpoint and just
// silently no-ops without one, so the landlord fills in everything,
// watches it all appear to work, and only discovers nothing was
// actually saved once they try to reach the dashboard for real -
// which is exactly the "have to redo it a second time" loop.
//
// The actual fix: stop depending on the password surviving in memory
// at all. By the time payment status here reads 'completed', a real
// M-Pesa payment (or an admin's manual confirmation) already tied
// unambiguously to this landlordId is every bit as strong an identity
// proof as a password re-check - so mint the session token right
// here, server-side, and hand it back in the same response. No
// separate login() call, no reliance on anything the frontend was
// holding onto - this can't be broken by a reload, a backgrounded tab,
// or a wait of any length, because there's nothing left in browser
// memory for the wait to lose.
function tokenForActivatedLandlord(landlordId) {
  return signToken({ id: landlordId, role: 'landlord' });
}
const { processPropertyPaymentCallback } = require('./property.controller');
const { normalizePhone } = require('../utils/phone');
const { applyPaymentToBalance, buildPrepaymentSummary, buildRentPeriodLabel } = require('../utils/prepayment');
const { validatePositiveAmount } = require('../utils/validateAmount');
const { applyUnitLimitChange } = require('../utils/unitLimitEnforcement');
const { captureException } = require('../services/sentry.service');
const tenantRatingReminderService = require('../services/tenantRatingReminder.service');
const { recordCommissionForPayment } = require('../services/baCommission.service');
const { consumeLoyaltyDiscount } = require('../services/landlordLoyalty.service');
const { createCoveragePeriod, computeRenewalStartDate } = require('../services/coveragePeriod.service');
const logger = require('../utils/logger');

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
    logger.error('[payment] initiateRentSTKPush error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to initiate payment.' });
  }
}

// ---------------------------------------------------------------------
// INITIATE STK PUSH FOR A UTILITY BILL - same mechanism as rent, but
// against a specific utility_invoices row instead of the tenant's
// rent balance. handleSTKCallback below routes the resulting
// payments.target_type='utility' row to the right invoice.
// ---------------------------------------------------------------------
async function initiateUtilityStkPush(req, res) {
  try {
    const tenantId = req.user.id;
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId is required.' });

    const { data: invoice, error: invErr } = await supabase.from('utility_invoices').select('*').eq('id', invoiceId).maybeSingle();
    if (invErr) throw invErr;
    if (!invoice || invoice.tenant_id !== tenantId) return res.status(404).json({ error: 'Utility invoice not found.' });
    if (invoice.status === 'paid') return res.status(409).json({ error: 'This bill has already been paid.' });

    const owed = Math.round((Number(invoice.amount) - Number(invoice.amount_paid || 0)) * 100) / 100;
    const { data: tenant, error } = await supabase.from('tenants').select('*, units(unit_payment_code)').eq('id', tenantId).single();
    if (error || !tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const stkResponse = await initiateSTKPush({
      phoneNumber: tenant.primary_phone,
      amount: owed,
      accountReference: tenant.units.unit_payment_code,
      transactionDesc: `${invoice.utility_type} bill`,
    });

    const { data: payment, error: insertError } = await supabase
      .from('payments')
      .insert({
        tenant_id: tenantId,
        unit_id: tenant.unit_id,
        landlord_id: tenant.landlord_id,
        amount: owed,
        payment_method: 'stk_push',
        mpesa_checkout_request_id: stkResponse.CheckoutRequestID,
        status: 'pending',
        target_type: 'utility',
        target_invoice_id: invoice.id,
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
    logger.error('[payment] initiateUtilityStkPush error:', err.message);
    captureException(err);
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
      return res.json({ status: 'completed', landlordId: subPayment.landlord_id, token: tokenForActivatedLandlord(subPayment.landlord_id) });
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
      logger.warn('[payment] checkSubscriptionPaymentStatus: querySTKPushStatus failed, still pending:', queryErr.message);
      captureException(queryErr);
      return res.json({ status: 'pending' });
    }

    const resultCode = Number(queryResult.ResultCode);
    if (resultCode === 0) {
      // Confirmed by Safaricom - complete activation now instead of
      // waiting for the callback (which may still arrive later too;
      // handleSTKCallback's idempotency guard makes that safe).
      await processSubscriptionPaymentCallback(subPayment, 0, null);
      return res.json({ status: 'completed', landlordId: subPayment.landlord_id, token: tokenForActivatedLandlord(subPayment.landlord_id) });
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
    logger.error('[payment] checkSubscriptionPaymentStatus error:', err.message);
    captureException(err);
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
      logger.warn('[payment] checkRentPaymentStatus: querySTKPushStatus failed, still pending:', queryErr.message);
      captureException(queryErr);
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
    logger.error('[payment] checkRentPaymentStatus error:', err.message);
    captureException(err);
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

    logger.warn('[payment] Callback received for unknown CheckoutRequestID:', CheckoutRequestID);
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    logger.error('[payment] handleSTKCallback error:', err.message);
    captureException(err);
    // Still 200 - we don't want Safaricom retry storms over our internal bugs.
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
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

  // RACE FIX: handleSTKCallback (the real webhook) and
  // checkRentPaymentStatus (the self-heal poll) can both end up calling
  // this function for the same payment - e.g. the webhook completes the
  // payment while a poll's querySTKPushStatus call is still in flight
  // with a stale, pre-completion snapshot of the row. Making this
  // update conditional on the row NOT already being 'completed' turns
  // it into an atomic guard: whichever caller gets here first wins and
  // flips the row, and the loser sees zero rows affected and bails out
  // below before ever touching tenant.balance_due, so the same payment
  // can never be applied to the ledger twice.
  const { data: updatedPaymentRows } = await supabase
    .from('payments')
    .update({
      status: 'completed',
      mpesa_transaction_id: mpesaReceiptNumber,
      mpesa_phone: phoneNumber ? String(phoneNumber) : null,
      paid_at: new Date().toISOString(),
    })
    .eq('id', payment.id)
    .neq('status', 'completed')
    .select('id');

  if (!updatedPaymentRows || updatedPaymentRows.length === 0) {
    // Already processed by another path (webhook vs. self-heal poll,
    // or Safaricom retrying the same callback) - don't double-apply.
    return;
  }

  // Utility bill STK push (Phase 2): credits the specific invoice
  // only, never tenants.balance_due, so rent and utility payments
  // stay on completely independent ledgers even over M-Pesa.
  if (payment.target_type === 'utility' && payment.target_invoice_id) {
    const { data: invoice } = await supabase.from('utility_invoices').select('*').eq('id', payment.target_invoice_id).maybeSingle();
    if (invoice) {
      const newAmountPaid = Math.round((Number(invoice.amount_paid || 0) + Number(amountPaid)) * 100) / 100;
      const newStatus = newAmountPaid >= Number(invoice.amount) ? 'paid' : 'partially_paid';
      await supabase.from('utility_invoices').update({ amount_paid: newAmountPaid, status: newStatus, updated_at: new Date().toISOString() }).eq('id', invoice.id);
      try {
        await notify('tenant', payment.tenant_id, payment.tenants?.primary_phone, `Your M-Pesa payment of KES ${Number(amountPaid).toLocaleString()} for your ${invoice.utility_type} bill was received.`, { category: 'account', title: 'Bill Payment Received' });
      } catch (notifyErr) {
        logger.error('[payment] processRentPaymentCallback (utility): notify failed:', notifyErr.message);
      }
    }
    return;
  }

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

  // Section 6 / FIX (spec item 2.2): snapshot the rent period this
  // payment covers and the tenant's balance immediately after it, so
  // the receipt always prints what was true at payment time - not
  // whatever the tenant's balance happens to be by the time someone
  // downloads the PDF. prepaymentInfo has to be computed BEFORE the
  // rent period label now, since an advance/extra-month payment needs
  // the label to span every month the resulting credit covers, not
  // just the current month (that was the bug - the label used to
  // ignore prepaymentInfo entirely and always print just "now").
  const paidAtDate = new Date();
  const dueDay = tenant.due_day_of_month || unit.due_day_of_month;
  const today = new Date();
  const nextCycleDueDate = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
  const prepaymentInfo = buildPrepaymentSummary(newBalance, rentAmount, nextCycleDueDate);
  const rentPeriodLabel = buildRentPeriodLabel(paidAtDate, prepaymentInfo, rentAmount);
  await supabase.from('payments').update({ rent_period: rentPeriodLabel, balance_after: newBalance }).eq('id', payment.id);

  if (isPartial) {
    await supabase.from('payments').update({ is_partial: true }).eq('id', payment.id);
  }

  const tenantUpdate = { balance_due: newBalance };

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

  // DIRECT REQUEST: a tenant payment landing is one of the two
  // triggers for the "rate this tenant" popup (the other is random).
  tenantRatingReminderService.queuePaymentReminder({
    landlordId: payment.landlord_id,
    tenantId: tenant.id,
    propertyId: unit?.property_id || null,
  });
}

async function processSubscriptionPaymentCallback(subPayment, resultCode, callbackMetadata) {
  if (resultCode !== 0) {
    await supabase.from('subscription_payments').update({ status: 'failed' }).eq('id', subPayment.id);
    return;
  }

  const mpesaReceiptNumber = extractMetadataValue(callbackMetadata, 'MpesaReceiptNumber');
  const phoneNumber = extractMetadataValue(callbackMetadata, 'PhoneNumber');
  const paidAtIso = new Date().toISOString();

  await supabase
    .from('subscription_payments')
    .update({
      status: 'completed',
      mpesa_transaction_id: mpesaReceiptNumber,
      mpesa_phone: phoneNumber ? String(phoneNumber) : null,
      paid_at: paidAtIso,
    })
    .eq('id', subPayment.id);

  const landlord = subPayment.landlords;
  if (!landlord) {
    // Should be impossible given the foreign key + join in
    // handleSTKCallback's select('*, landlords(*)'), but if it ever
    // happens (e.g. landlord row deleted between insert and callback,
    // or a join/alias mismatch), fail loudly instead of crashing on
    // landlord.subscription_status below with an opaque TypeError.
    logger.error(
      `[payment] CRITICAL: subscription_payments row ${subPayment.id} has no joined landlord (landlord_id=${subPayment.landlord_id}). Cannot activate account.`
    );
    captureException(new Error(`subscription_payments row ${subPayment.id} has no joined landlord (landlord_id=${subPayment.landlord_id})`));
    return;
  }

  const isFirstPayment = landlord.subscription_status === 'pending';

  // FIX (direct request: "no matter how much a landlord first signs
  // up with, that account qualifies for payment... right now all are
  // just saying 0 qualifying"): a BA-referred landlord now qualifies
  // the INSTANT their first subscription payment completes - right
  // here, synchronously - rather than waiting for the once-daily
  // baQualification cron job, which also used to require at least one
  // unit to be set up first. Neither delay nor unit-count is part of
  // the qualification bar anymore: signing up and paying is enough.
  if (isFirstPayment && landlord.ba_id && landlord.ba_qualification_status === 'pending') {
    const qualifiedAt = new Date().toISOString();
    const { error: qualifyErr } = await supabase
      .from('landlords')
      .update({ ba_qualification_status: 'qualified', ba_qualified_at: qualifiedAt })
      .eq('id', landlord.id)
      .eq('ba_qualification_status', 'pending'); // idempotency guard, same convention as the cron job
    if (qualifyErr) {
      logger.error(`[payment] Failed to qualify BA landlord ${landlord.id} inline:`, qualifyErr.message);
      captureException(qualifyErr);
    } else {
      landlord.ba_qualification_status = 'qualified';
      logActivity({
        actorType: 'system',
        action: 'ba_landlord_qualified',
        targetType: 'landlord',
        targetId: landlord.id,
        metadata: { baId: landlord.ba_id, trigger: 'first_payment' },
      });
    }
  }

  // FIX (direct request: "it should only be one time, the moment a
  // landlord signs up and pays the subscription fee" - NOT recurring
  // for as long as they stay subscribed): commission is now only ever
  // computed on a landlord's FIRST subscription payment, not on every
  // renewal. subscription_payment_id still carries a unique index on
  // ba_commission_earnings as a belt-and-suspenders idempotency guard,
  // but the isFirstPayment check here is what actually makes this
  // one-time rather than recurring.
  if (isFirstPayment) {
    await recordCommissionForPayment({ id: subPayment.id, landlord_id: subPayment.landlord_id, amount: subPayment.amount, paid_at: paidAtIso });
  }

  if (isFirstPayment) {
    // First-ever payment completes registration (blueprint 3.1)
    await activateLandlordAfterPayment(landlord.id, subPayment.period_months, subPayment.units_count, subPayment.amount, subPayment.id);
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

    // Phase 13 - true MRR: this renewal's own coverage period.
    // computeRenewalStartDate looks at the landlord's PRE-update
    // expiry (still held in `landlord.subscription_expires_at` above -
    // the update() call just now doesn't mutate this local object) to
    // tell an early renewal (still-future expiry - new period starts
    // the day after the old one ends) apart from a standard one
    // (already-lapsed or first time - starts today). The period's end
    // date deliberately mirrors the currentExpiry just written to the
    // landlord row above, so this ledger always agrees with what the
    // landlord's actual access is set to.
    const coverageStart = computeRenewalStartDate(landlord.subscription_expires_at);
    await createCoveragePeriod({
      landlordId: landlord.id,
      kind: 'renewal',
      startDate: coverageStart,
      endDate: currentExpiry,
      unitsCovered: subPayment.units_count,
      amountPaid: subPayment.amount,
      periodMonths: subPayment.period_months,
      subscriptionPaymentId: subPayment.id,
    });

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

    // ONE-TIME DISCOUNT CONSUMPTION (direct request: "after a landlord
    // renews subscription with the discount... it should expire
    // unless given another one"): only reached here because this
    // renewal payment just CONFIRMED complete (resultCode === 0,
    // checked above) - a failed/abandoned STK push returns before
    // this point and never touches the discount. Whichever discount
    // was active at the moment renewSubscription initiated this
    // payment (captured on subPayment.loyalty_discount_id) is
    // deactivated now, so it won't apply again on the next renewal
    // unless the landlord is granted a new one.
    if (subPayment.loyalty_discount_id) {
      await consumeLoyaltyDiscount(subPayment.loyalty_discount_id, { subscriptionPaymentId: subPayment.id });
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
    const { transactionCode, amountPaid, mpesaPayerName, mpesaPayerPhone, mpesaSmsTimestamp, targetInvoiceId } = req.body;

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

    // If this proof is for a specific utility bill (water/electricity)
    // rather than rent, confirm the invoice is really this tenant's
    // and still owed before anything is created against it.
    let targetType = 'rent';
    if (targetInvoiceId) {
      const { data: invoice, error: invErr } = await supabase
        .from('utility_invoices')
        .select('id, tenant_id, status')
        .eq('id', targetInvoiceId)
        .maybeSingle();
      if (invErr) throw invErr;
      if (!invoice || invoice.tenant_id !== tenantId) {
        return res.status(404).json({ error: 'Utility invoice not found for this tenant.' });
      }
      if (invoice.status === 'paid') {
        return res.status(409).json({ error: 'This bill has already been marked paid.' });
      }
      targetType = 'utility';
    }

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
        target_type: targetType,
        target_invoice_id: targetType === 'utility' ? targetInvoiceId : null,
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
        logger.error('[payment] submitPaybillTransaction: notify failed (non-blocking):', notifyErr.message);
        captureException(notifyErr);
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
    logger.error('[payment] submitPaybillTransaction error:', err.message);
    captureException(err);
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
    logger.error('[payment] getMyLatestPaybillConfirmation error:', err.message);
    captureException(err);
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

    const { data: tenant, error: fetchError } = await supabase.from('tenants').select('*, units(rent_amount, due_day_of_month, property_id)').eq('id', tenantId).single();
    if (fetchError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });
    if (tenant.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this tenant.' });
    if (await blockIfSubscriptionExpired(req, res, landlordId, tenant.units?.property_id || null)) return;

    // Section 6 / FIX (spec item 2.2): same rent-period label as the
    // STK path, based on the date the landlord recorded as when the
    // payment happened (not "now") - a landlord backfilling last
    // month's cash payment should get a receipt that says last month,
    // not today. Ledger + prepayment info has to be computed first so
    // an advance/extra-month manual payment (e.g. "tenant paid 5.5
    // months in cash") gets a label spanning every month it covers,
    // not just the single recorded month.
    const currentlyOwed = Number(tenant.balance_due) || 0;
    const amountNum = validatedManualAmount;
    const rentAmount = Number(tenant.rent_override || tenant.units.rent_amount || 0);
    const newBalance = applyPaymentToBalance(currentlyOwed, amountNum);
    const dueDay = tenant.due_day_of_month || tenant.units.due_day_of_month;
    const paymentDateObj = new Date(paymentDate);
    const nextCycleDueDate = new Date(paymentDateObj.getFullYear(), paymentDateObj.getMonth() + 1, dueDay);
    const prepaymentInfo = buildPrepaymentSummary(newBalance, rentAmount, nextCycleDueDate);
    const rentPeriodLabel = buildRentPeriodLabel(paymentDateObj, prepaymentInfo, rentAmount);

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
        rent_period: rentPeriodLabel,
        balance_after: newBalance,
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
    const tenantUpdate = { balance_due: newBalance };

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

    // DIRECT REQUEST: a tenant payment landing is one of the two
    // triggers for the "rate this tenant" popup (the other is random).
    tenantRatingReminderService.queuePaymentReminder({
      landlordId,
      tenantId,
      propertyId: tenant.units?.property_id || null,
    });

    return res.status(201).json({
      message: 'Manual payment recorded.',
      payment,
      prepayment: prepaymentInfo,
    });
  } catch (err) {
    logger.error('[payment] recordManualPayment error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to record manual payment.' });
  }
}

// ---------------------------------------------------------------------
// LANDLORD/MANAGER MANUAL UTILITY PAYMENT ENTRY (Phase 2, item 6):
// water/electricity bills are frequently paid separately from rent -
// in person, over the counter, via a different paybill - so a
// landlord/manager needs to be able to record that directly without
// the tenant submitting proof first. Scope is either a single
// utility_invoices row (invoiceId) or every currently-unpaid invoice
// of one utility type across the property (propertyId + utilityType),
// for the "one payment covered everyone's water this month" case.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// List every currently-open (not yet fully paid) invoice of one
// utility type across a property, so a landlord/manager can pick
// exactly which unit's bill they're recording a payment for in
// RecordUtilityPaymentModal.jsx. Read-only counterpart to the bulk
// path in recordManualUtilityPayment below.
// ---------------------------------------------------------------------
async function listOpenUtilityInvoicesForProperty(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId, utilityType } = req.query;
    if (!propertyId || !utilityType) {
      return res.status(400).json({ error: 'propertyId and utilityType are required.' });
    }

    const { data: property, error: propErr } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('landlord_id', landlordId)
      .maybeSingle();
    if (propErr) throw propErr;
    if (!property) return res.status(404).json({ error: 'Apartment not found on your account.' });

    const { data: units, error: unitsErr } = await supabase.from('units').select('id, unit_name').eq('property_id', propertyId);
    if (unitsErr) throw unitsErr;
    const unitIds = (units || []).map((u) => u.id);
    const unitNameById = Object.fromEntries((units || []).map((u) => [u.id, u.unit_name]));

    const { data: invoices, error } = await supabase
      .from('utility_invoices')
      .select('*')
      .eq('landlord_id', landlordId)
      .eq('utility_type', utilityType)
      .in('unit_id', unitIds.length ? unitIds : ['00000000-0000-0000-0000-000000000000'])
      .neq('status', 'paid')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const withUnitName = (invoices || []).map((inv) => ({ ...inv, unit_name: unitNameById[inv.unit_id] || null }));
    return res.json({ invoices: withUnitName });
  } catch (err) {
    logger.error('[payment] listOpenUtilityInvoicesForProperty error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load open bills for this apartment.' });
  }
}

async function recordManualUtilityPayment(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { invoiceId, propertyId, utilityType, amount, paymentDate, mpesaReference, note } = req.body;

    if (!invoiceId && !(propertyId && utilityType)) {
      return res.status(400).json({ error: 'Provide either invoiceId (one bill) or propertyId + utilityType (every unpaid bill of that type on the property).' });
    }
    if (!paymentDate) return res.status(400).json({ error: 'paymentDate is required.' });

    let invoices = [];
    if (invoiceId) {
      const { data: invoice, error } = await supabase.from('utility_invoices').select('*').eq('id', invoiceId).maybeSingle();
      if (error) throw error;
      if (!invoice) return res.status(404).json({ error: 'Utility invoice not found.' });
      if (invoice.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this invoice.' });
      if (invoice.status === 'paid') return res.status(409).json({ error: 'This bill is already marked paid.' });
      invoices = [invoice];
    } else {
      const { data: units } = await supabase.from('units').select('id').eq('property_id', propertyId);
      const unitIds = (units || []).map((u) => u.id);
      const { data: openInvoices, error } = await supabase
        .from('utility_invoices')
        .select('*')
        .eq('landlord_id', landlordId)
        .eq('utility_type', utilityType)
        .in('unit_id', unitIds)
        .neq('status', 'paid');
      if (error) throw error;
      invoices = openInvoices || [];
      if (invoices.length === 0) return res.status(404).json({ error: `No unpaid ${utilityType} bills found for this property.` });
    }

    const perInvoiceAmount = amount != null ? validatePositiveAmount(amount) : null;
    const results = [];
    for (const invoice of invoices) {
      const payAmount = perInvoiceAmount != null ? Math.min(perInvoiceAmount, Number(invoice.amount) - Number(invoice.amount_paid || 0)) : Number(invoice.amount) - Number(invoice.amount_paid || 0);
      if (payAmount <= 0) continue;

      const newAmountPaid = Math.round((Number(invoice.amount_paid || 0) + payAmount) * 100) / 100;
      const newStatus = newAmountPaid >= Number(invoice.amount) ? 'paid' : 'partially_paid';
      await supabase.from('utility_invoices').update({ amount_paid: newAmountPaid, status: newStatus, updated_at: new Date().toISOString() }).eq('id', invoice.id);

      const { data: payment } = await supabase
        .from('payments')
        .insert({
          tenant_id: invoice.tenant_id,
          unit_id: invoice.unit_id,
          landlord_id: landlordId,
          amount: payAmount,
          payment_method: 'manual',
          mpesa_transaction_id: mpesaReference || null,
          status: 'completed',
          recorded_by_landlord: true,
          recorded_note: note || null,
          paid_by: 'self',
          paid_at: paymentDate,
          target_type: 'utility',
          target_invoice_id: invoice.id,
        })
        .select()
        .single();

      results.push({ invoiceId: invoice.id, status: newStatus, payment });

      try {
        const { data: tenant } = await supabase.from('tenants').select('primary_phone').eq('id', invoice.tenant_id).maybeSingle();
        if (tenant) {
          await notify('tenant', invoice.tenant_id, tenant.primary_phone, `Your ${invoice.utility_type} bill of KES ${payAmount.toLocaleString()} has been recorded as paid.`, { category: 'account', title: 'Bill Payment Recorded' });
        }
      } catch (notifyErr) {
        logger.error('[payment] recordManualUtilityPayment: notify failed (non-blocking):', notifyErr.message);
      }
    }

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'manual_utility_payment_recorded',
      targetType: invoiceId ? 'utility_invoice' : 'property',
      targetId: invoiceId || propertyId,
      reason: note,
      metadata: { utilityType, amount, mpesaReference, invoicesAffected: results.length },
    });

    return res.status(201).json({ message: `Recorded payment on ${results.length} bill${results.length === 1 ? '' : 's'}.`, results });
  } catch (err) {
    logger.error('[payment] recordManualUtilityPayment error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to record utility payment.' });
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

    const { data: payment, error: fetchErr } = await supabase.from('payments').select('id, landlord_id, units(property_id)').eq('id', paymentId).single();
    if (fetchErr || !payment) return res.status(404).json({ error: 'Payment not found.' });
    if (payment.landlord_id !== landlordId) return res.status(403).json({ error: 'This payment is not on your account.' });
    if (await blockIfSubscriptionExpired(req, res, landlordId, payment.units?.property_id || null)) return;

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
    logger.error('[payment] deletePayment error:', err.message);
    captureException(err);
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
      .select('id, tenant_id, landlord_id, amount, paid_at, payment_method, status, tenants(full_name), units(unit_name)')
      .eq('landlord_id', landlordId)
      .order('paid_at', { ascending: false, nullsFirst: false })
      .limit(1000);

    if (unitIds) query = query.in('unit_id', unitIds);

    const { data: payments, error } = await query;
    if (error) throw error;

    return res.json({ payments: payments || [] });
  } catch (err) {
    logger.error('[payment] getLandlordPaymentHistory error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch payment history.' });
  }
}

// LANDLORD/MANAGER/CARETAKER: DIRECT REQUEST - download every
// completed payment's receipt (same official PDF as the tenant-facing
// one) in a single zip, for record-keeping. Optionally scoped to one
// property and/or a date range via query params, same convention as
// getLandlordPaymentHistory above.
async function downloadAllReceiptsZip(req, res) {
  try {
    const archiver = require('archiver');
    const { generatePaymentReceiptPdfBuffer } = require('../services/pdfReport.service');
    const landlordId = effectiveLandlordId(req);
    const { propertyId, from, to } = req.query;

    let query = supabase
      .from('payments')
      .select('*, tenants(full_name), units(unit_name, property_id, properties(name)), landlords(full_name), utility_invoices:target_invoice_id(utility_type, month_key, amount, amount_paid, status)')
      .eq('landlord_id', landlordId)
      .eq('status', 'completed')
      .order('paid_at', { ascending: false });

    if (from) query = query.gte('paid_at', from);
    if (to) query = query.lte('paid_at', to);

    const { data: payments, error } = await query;
    if (error) throw error;

    // Filtered in JS (rather than relying on a query-level join filter,
    // which behaves inconsistently across Supabase client versions) so
    // a property scope is never silently ignored.
    const scoped = propertyId ? (payments || []).filter((p) => p.units?.property_id === propertyId) : (payments || []);

    if (!scoped.length) {
      return res.status(404).json({ error: 'No completed payments found for the selected filter.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="rentapay-receipts-${new Date().toISOString().slice(0, 10)}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { throw err; });
    archive.pipe(res);

    const { data: landlordForReceipts } = await supabase.from('landlords').select('kra_pin').eq('id', landlordId).single();

    const generatedAt = new Date();
    for (const payment of scoped) {
      const buffer = await generatePaymentReceiptPdfBuffer({
        payment,
        tenantName: payment.tenants?.full_name,
        unitName: payment.units?.unit_name,
        propertyName: payment.units?.properties?.name,
        landlordName: payment.landlords?.full_name,
        landlordKraPin: landlordForReceipts?.kra_pin || null,
        generatedAt,
      });
      const tenantSlug = (payment.tenants?.full_name || 'tenant').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const dateSlug = payment.paid_at ? new Date(payment.paid_at).toISOString().slice(0, 10) : 'undated';
      archive.append(buffer, { name: `${tenantSlug}-${dateSlug}-${payment.id.slice(0, 8)}.pdf` });
    }

    await archive.finalize();
  } catch (err) {
    logger.error('[payment] downloadAllReceiptsZip error:', err.message);
    captureException(err);
    if (!res.headersSent) return res.status(500).json({ error: 'Failed to build receipts archive.' });
    res.end();
  }
}


// payments. The "Receipt" button in the tenant portal used to just
// call window.print() on the table row - this gives a real document
// they can save, matching the "landlord PDF reports" pattern already
// used for the collection summary (see pdfReport.service.js).
// Section 6: opened up beyond tenants to landlord/manager too - this
// is exactly the "manual, explicit tap" trigger the spec requires for
// landlord/manager receipt access (they never get the receipt pushed
// to them automatically; this endpoint only fires when someone taps
// "Download receipt" on a specific payment record).
async function downloadReceiptPdf(req, res) {
  try {
    const { paymentId } = req.params;

    const { data: payment, error } = await supabase
      .from('payments')
      .select('*, tenants(full_name), units(unit_name, property_id, properties(name)), landlords(full_name, kra_pin), utility_invoices:target_invoice_id(utility_type, month_key, amount, amount_paid, status)')
      .eq('id', paymentId)
      .maybeSingle();
    if (error) throw error;
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });

    if (req.user.role === 'tenant') {
      if (payment.tenant_id !== req.user.id) return res.status(403).json({ error: 'This is not your payment.' });
    } else {
      // landlord / manager
      const landlordId = effectiveLandlordId(req);
      if (payment.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this payment.' });
      const propertyAccessError = await checkManagerPropertyAccess(req, payment.units?.property_id);
      if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);
    }
    if (payment.status !== 'completed') return res.status(400).json({ error: 'A receipt is only available for completed payments.' });

    const { generatePaymentReceiptPdf } = require('../services/pdfReport.service');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rentapay-receipt-${paymentId.slice(0, 8)}.pdf"`);

    await generatePaymentReceiptPdf(res, {
      payment,
      tenantName: payment.tenants?.full_name,
      unitName: payment.units?.unit_name,
      propertyName: payment.units?.properties?.name,
      landlordName: payment.landlords?.full_name,
      landlordKraPin: payment.landlords?.kra_pin || null,
      generatedAt: new Date(),
    });
  } catch (err) {
    logger.error('[payment] downloadReceiptPdf error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate receipt.' });
  }
}

module.exports = {
  initiateRentSTKPush,
  initiateUtilityStkPush,
  checkRentPaymentStatus,
  checkSubscriptionPaymentStatus,
  handleSTKCallback,
  submitPaybillTransaction,
  getMyLatestPaybillConfirmation,
  recordManualPayment,
  recordManualUtilityPayment,
  listOpenUtilityInvoicesForProperty,
  getLandlordPaymentHistory,
  deletePayment,
  downloadReceiptPdf,
  downloadAllReceiptsZip,
};
