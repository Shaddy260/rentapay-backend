// src/controllers/landlordManualSubscriptionPayment.controller.js
//
// Direct request: "sometimes the payment fails or delays or the popup
// is not sent, so there should be a ui underneath that says didn't
// receive the popup, pay manually...that payment confirmation should
// land in admin portal under...landlords manual payment confirmations
// ...when i confirm it should proceed with the next step of signing
// up, or the acct verified or not verified...also include delete ui."
//
// Mirrors payment.controller.js's submitPaybillTransaction /
// pendingPaymentConfirmation.controller.js pattern, but for a
// landlord/manager/caretaker paying THEIR OWN platform subscription
// to RentaPay's paybill, reviewed by an admin rather than a landlord.

const supabase = require('../config/supabase');
const { effectiveLandlordId } = require('../middleware/auth.middleware');
const { normalizePhone } = require('../utils/phone');
const { validatePositiveAmount } = require('../utils/validateAmount');
const { notify } = require('../services/notify.service');
const { logActivity } = require('../services/activityLog.service');
const { activateLandlordAfterPayment } = require('./auth.controller');
const { recordCommissionForPayment } = require('../services/baCommission.service');
const { completePropertyPurchase } = require('./property.controller');
const { signToken } = require('../middleware/auth.middleware');
const { applyUnitLimitChange } = require('../utils/unitLimitEnforcement');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const templates = require('../services/notificationTemplates');
const { getActiveDiscountRecordForLandlord, consumeLoyaltyDiscount } = require('../services/landlordLoyalty.service');
const { calculateSubscriptionCost } = require('../utils/pricing');
const { PLATFORM_PAYBILL_NUMBER, PLATFORM_PAYBILL_ACCOUNT_NUMBER } = require('../constants/platformPaybill');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

// THE FIX for "admin taps Confirm/Reject and nothing happens": the
// super-admin account (blueprint 13.3) is a single hardcoded login
// with id 'super-admin' - not a real row/UUID anywhere in the
// database (see adminLogin in auth.controller.js). actioned_by_
// admin_id below is a `uuid` column, so writing the literal string
// 'super-admin' into it always failed at the database level with
// "invalid input syntax for type uuid" - the update never happened,
// the request 500'd, and the row silently stayed 'pending' no matter
// which button was tapped. This column is nullable and has no
// meaningful use for a single-admin system anyway, so we simply skip
// setting it when the acting id isn't a real UUID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function adminIdOrNull(id) {
  return UUID_RE.test(id || '') ? id : null;
}

// P1 (roadmap): "flag (not block) a submission where amount_paid
// differs materially from the expected total". KES 1 covers rounding
// noise from calculateSubscriptionCost's own rounding steps without
// missing a genuine underpayment.
const AMOUNT_MISMATCH_THRESHOLD = 1;
function isAmountMismatch(amountPaid, expectedAmount) {
  if (expectedAmount == null) return false;
  return Math.abs(Number(amountPaid) - Number(expectedAmount)) > AMOUNT_MISMATCH_THRESHOLD;
}

// ---------------------------------------------------------------------
// LANDLORD/MANAGER/CARETAKER: submit proof of a manual payment made
// directly to RentaPay's platform paybill (no Daraja/STK involved).
// ---------------------------------------------------------------------
async function submitManualSubscriptionPayment(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId, propertyPaymentId, transactionCode, amountPaid, mpesaPayerName, mpesaPayerPhone, mpesaSmsTimestamp, periodMonths, unitsCount } = req.body;

    if (!transactionCode || amountPaid == null || !mpesaPayerName || !mpesaPayerPhone || !unitsCount) {
      return res.status(400).json({ error: 'transactionCode, amountPaid, mpesaPayerName, mpesaPayerPhone, and unitsCount are required.' });
    }

    // For the "add/renew a property" STK-failed fallback (see
    // initiatePropertyPurchase / renewPropertySubscription's stkFailed),
    // propertyPaymentId points at the already-created pending
    // property_payments row - confirm the landlord actually owns it
    // before letting them attach a manual payment submission to it.
    // Also carries `amount`, the authoritative expected total already
    // computed (discount included) when that property payment was
    // initiated - reused below as this submission's expected_amount
    // instead of recomputing, since a property purchase/renewal can
    // use a chosen period that differs from the landlord-wide one.
    let propPayment = null;
    if (propertyPaymentId) {
      const { data: fetchedPropPayment, error: propPaymentErr } = await supabase
        .from('property_payments')
        .select('id, landlord_id, amount')
        .eq('id', propertyPaymentId)
        .maybeSingle();
      if (propPaymentErr || !fetchedPropPayment || fetchedPropPayment.landlord_id !== landlordId) {
        return res.status(404).json({ error: 'Property payment not found on your account.' });
      }
      propPayment = fetchedPropPayment;
    }
    const normalizedPhone = normalizePhone(mpesaPayerPhone);
    if (!normalizedPhone) return res.status(400).json({ error: 'mpesaPayerPhone must be a valid phone number.' });
    const validatedAmount = validatePositiveAmount(amountPaid);
    if (validatedAmount === null) return res.status(400).json({ error: 'amountPaid must be a valid positive number.' });

    const role = req.user.role; // 'landlord' | 'manager' | 'caretaker' (roleLevel distinguishes manager/caretaker on the same table)
    const submittedByRole = role === 'landlord' ? 'landlord' : (req.user.roleLevel === 'caretaker' ? 'caretaker' : 'manager');

    // FIX (direct request: "a landlord can decide to submit
    // again a code that has been used already...it does not flag this
    // like how the tenants side is flagged"). Same pattern as
    // payment.controller.js's submitPaybillTransaction: not an
    // automatic rejection (a genuinely new payment could coincidentally
    // share a mistyped code with an old one), just a loud flag so the
    // admin reviewing it can't miss that this exact code was already
    // used for a confirmed payment.
    const normalizedTxCode = String(transactionCode).trim().toUpperCase();
    const { data: existingConfirmed } = await supabase
      .from('landlord_manual_subscription_payments')
      .select('id')
      .eq('transaction_code', normalizedTxCode)
      .eq('status', 'confirmed')
      .order('confirmed_or_rejected_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // ONE-TIME DISCOUNT CONSUMPTION: capture whichever loyalty discount
    // is active for this landlord right now, at the moment this manual
    // payment is SUBMITTED - mirrors renewSubscription's STK path. It's
    // only actually consumed later, once an admin CONFIRMS this record
    // (see confirmManualSubscriptionPayment) - a rejected or never-
    // reviewed submission never touches the discount.
    const discountRecord = await getActiveDiscountRecordForLandlord(landlordId);

    // P1 (roadmap): "compute the expected total (calculateSubscriptionCost)
    // and store it alongside the submitted amount". A property purchase/
    // renewal already has its authoritative amount locked in on
    // property_payments at initiation (propPayment.amount, above) - reuse
    // that rather than recomputing, since it may use a different period
    // than the landlord-wide subscription and its own captured discount.
    // Otherwise (landlord-wide first payment or renewal) compute fresh
    // against what was actually submitted, so a landlord who fabricates a
    // smaller units/period pair to lower the "expected" number is still
    // visible to the admin as amount_paid vs THIS (real) expected total.
    let expectedAmount = null;
    try {
      if (propPayment) {
        expectedAmount = propPayment.amount != null ? Number(propPayment.amount) : null;
      } else {
        const quote = await calculateSubscriptionCost(Number(unitsCount), Number(periodMonths) || 1, landlordId);
        expectedAmount = quote.totalCost;
      }
    } catch (quoteErr) {
      // Never block a submission over a pricing lookup hiccup - this is
      // a review aid for the admin, not a gate on the landlord.
      logger.warn('[landlordManualSubscriptionPayment] failed to compute expected amount:', quoteErr.message);
    }

    const { data: record, error: insertErr } = await supabase
      .from('landlord_manual_subscription_payments')
      .insert({
        landlord_id: landlordId,
        property_id: propertyId || null,
        property_payment_id: propertyPaymentId || null,
        submitted_by_role: submittedByRole,
        submitted_by_landlord_id: role === 'landlord' ? req.user.id : null,
        submitted_by_manager_id: role !== 'landlord' ? req.user.id : null,
        transaction_code: normalizedTxCode,
        amount_paid: validatedAmount,
        expected_amount: expectedAmount,
        mpesa_payer_name: String(mpesaPayerName).trim(),
        mpesa_payer_phone: normalizedPhone,
        mpesa_sms_timestamp: mpesaSmsTimestamp || null,
        period_months: Number(periodMonths) || 1,
        units_count: Number(unitsCount),
        duplicate_of: existingConfirmed ? existingConfirmed.id : null,
        loyalty_discount_id: discountRecord ? discountRecord.id : null,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    logActivity({
      actorType: role,
      actorId: req.user.id,
      action: 'landlord_manual_subscription_payment_submitted',
      targetType: 'landlord_manual_subscription_payment',
      targetId: record.id,
      metadata: { landlordId, amountPaid: validatedAmount, isDuplicate: !!existingConfirmed },
    });

    // FIX (direct request: "in admin also should be notified on
    // payment submissions for landlords"): now that admin
    // is a supported notify() recipient (see
    // 2026-07-admin-notifications-support.sql), this gives admin the
    // full treatment - SMS + inbox row + real OS push - instead of
    // the SMS-only stopgap this used to be. Deliberately not awaited -
    // a slow/down delivery channel should never delay the landlord's
    // "submitted" confirmation.
    notify(
      'admin',
      'super-admin',
      process.env.SUPER_ADMIN_PHONE,
      `New landlord manual payment submitted (KES ${validatedAmount}, code ${normalizedTxCode})${existingConfirmed ? ' - DUPLICATE transaction code, flagged' : ''}. Review in the admin panel.`,
      { category: 'account', title: 'Manual Payment Submitted' }
    ).catch((notifyErr) => { logger.warn('[landlordManualSubscriptionPayment] admin notify failed:', notifyErr.message); captureException(notifyErr); });

    return res.status(201).json({
      message: existingConfirmed
        ? 'This transaction code was already used for a previous confirmed payment and cannot be reused. This has been flagged for the admin to review - please contact support if you believe this is a mistake.'
        : 'Submitted. Your payment will be reviewed and your subscription updated shortly.',
      isDuplicate: !!existingConfirmed,
      confirmation: record,
      expectedAmount,
      amountMismatch: isAmountMismatch(validatedAmount, expectedAmount),
      paybillNumber: PLATFORM_PAYBILL_NUMBER,
      accountNumber: PLATFORM_PAYBILL_ACCOUNT_NUMBER,
    });
  } catch (err) {
    logger.error('[landlordManualSubscriptionPayment] submit error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit payment.' });
  }
}

// The landlord/manager/caretaker's own most recent submission, so the
// UI can show "submitted, waiting for approval" without blocking the
// pay-again button (same fix as the tenant-side stuck-confirmation bug).
async function getMyLatestManualSubscriptionPayment(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { data, error } = await supabase
      .from('landlord_manual_subscription_payments')
      .select('*')
      .eq('landlord_id', landlordId)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return res.json(data || null);
  } catch (err) {
    logger.error('[landlordManualSubscriptionPayment] getMyLatest error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch payment status.' });
  }
}

// ---------------------------------------------------------------------
// ADMIN: list / confirm / reject / delete
// ---------------------------------------------------------------------
async function listManualSubscriptionPayments(req, res) {
  try {
    const status = req.query.status || 'pending';
    let query = supabase
      .from('landlord_manual_subscription_payments')
      .select('*, landlords!landlord_manual_subscription_payments_landlord_id_fkey(full_name, phone, subscription_status)')
      .order('submitted_at', { ascending: false });
    if (status !== 'all') query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    // P1: same "flag, don't block" treatment as the duplicate-
    // transaction-code check - surface a material mismatch between
    // what was submitted and what the system expected, without
    // stopping the admin from confirming anyway if they judge it fine
    // (e.g. a landlord who rounded up on the M-Pesa side).
    const withMismatchFlag = (data || []).map((item) => ({
      ...item,
      amount_mismatch: isAmountMismatch(item.amount_paid, item.expected_amount),
    }));
    return res.json(withMismatchFlag);
  } catch (err) {
    logger.error('[landlordManualSubscriptionPayment] list error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch payments.' });
  }
}

async function confirmManualSubscriptionPayment(req, res) {
  try {
    const { id } = req.params;
    const { data: record, error: fetchErr } = await supabase
      .from('landlord_manual_subscription_payments')
      .select('*, landlords!landlord_manual_subscription_payments_landlord_id_fkey(*)')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!record) return res.status(404).json({ error: 'Payment record not found.' });
    if (record.status !== 'pending') return res.status(400).json({ error: `Already ${record.status}.` });

    const landlord = record.landlords;
    const isFirstPayment = landlord.subscription_status === 'pending';

    if (record.property_payment_id) {
      // "Add a property" or "renew a property" where the STK push
      // itself failed to send (see initiatePropertyPurchase /
      // renewPropertySubscription's stkFailed fallback). The pending
      // property_payments row already has everything needed (new
      // property's name/location/etc, or which property is renewing) -
      // completePropertyPurchase is the same idempotent completion used
      // by the Daraja callback and the self-heal poll, so this just
      // triggers it manually instead of waiting on Safaricom.
      const { data: propPayment, error: propPaymentErr } = await supabase
        .from('property_payments')
        .select('*')
        .eq('id', record.property_payment_id)
        .maybeSingle();
      if (propPaymentErr || !propPayment) return res.status(404).json({ error: 'Underlying property payment not found.' });
      await completePropertyPurchase(propPayment);
    } else if (record.property_id) {
      // Renewing/activating one specific apartment's own clock.
      // FIX: this used to always compute expiry as now + period_months,
      // throwing away any days the property still had left on its
      // current clock (e.g. 20 days remaining + a 2-month renewal used
      // to land on "2 months from today" instead of "2 months + 20
      // days from today"). Same carry-forward rule as the landlord-level
      // branch below: start from the property's existing
      // subscription_expires_at if it's still in the future, only fall
      // back to "now" if the property had already lapsed.
      const { data: existingProperty } = await supabase
        .from('properties')
        .select('subscription_expires_at')
        .eq('id', record.property_id)
        .maybeSingle();
      let propertyExpiry = existingProperty?.subscription_expires_at
        ? new Date(existingProperty.subscription_expires_at)
        : new Date();
      if (propertyExpiry < new Date()) propertyExpiry = new Date();
      propertyExpiry.setMonth(propertyExpiry.getMonth() + record.period_months);
      await supabase
        .from('properties')
        .update({
          unit_limit: record.units_count,
          subscription_period_months: record.period_months,
          subscription_started_at: new Date().toISOString(),
          subscription_expires_at: propertyExpiry.toISOString(),
          subscription_status: 'active',
        })
        .eq('id', record.property_id);
    } else if (isFirstPayment) {
      // First-ever payment: this is the "next step of signing up /
      // account verified" moment - same activation used by the
      // Daraja auto-confirm path (verifies the account directly and
      // flips status to active - no OTP involved).
      await supabase.from('landlords').update({ unit_limit: record.units_count }).eq('id', landlord.id);
      await activateLandlordAfterPayment(landlord.id, record.period_months);

      // FIX (direct request: "the system doesn't seem to be picking up
      // the data automatically... resolve that, to match percentage of
      // what is set in admin portal" - "0 qualifying"): a landlord who
      // pays via manual confirmation (STK popup never arrived) used to
      // never qualify their referring BA for commission at all - this
      // whole branch never touched ba_qualification_status or wrote
      // any ba_commission_earnings row, unlike the Daraja auto-confirm
      // path in payment.controller.js. Mirrors that path exactly now:
      // insert the subscription_payments row this manual flow never
      // created (needed since ba_commission_earnings.subscription_payment_id
      // is a foreign key into that table), qualify the BA immediately
      // (no unit-count requirement, no waiting on the nightly cron),
      // then record a ONE-TIME commission against this first payment.
      const plan = record.units_count <= 10 ? 'starter' : record.units_count <= 50 ? 'standard' : 'premium';
      const paidAtIso = new Date().toISOString();
      const { data: subPaymentRow, error: subPaymentErr } = await supabase
        .from('subscription_payments')
        .insert({
          landlord_id: landlord.id,
          plan,
          period_months: record.period_months,
          units_count: record.units_count,
          amount: record.amount_paid,
          mpesa_transaction_id: record.transaction_code,
          mpesa_phone: record.mpesa_payer_phone,
          status: 'completed',
          paid_at: paidAtIso,
        })
        .select()
        .maybeSingle();
      if (subPaymentErr) {
        logger.error(`[landlordManualSubscriptionPayment] Failed to record subscription_payments row for manual payment ${record.id}:`, subPaymentErr.message);
        captureException(subPaymentErr);
      }

      if (landlord.ba_id && landlord.ba_qualification_status === 'pending') {
        const qualifiedAt = new Date().toISOString();
        const { error: qualifyErr } = await supabase
          .from('landlords')
          .update({ ba_qualification_status: 'qualified', ba_qualified_at: qualifiedAt })
          .eq('id', landlord.id)
          .eq('ba_qualification_status', 'pending');
        if (qualifyErr) {
          logger.error(`[landlordManualSubscriptionPayment] Failed to qualify BA landlord ${landlord.id} inline:`, qualifyErr.message);
          captureException(qualifyErr);
        } else {
          landlord.ba_qualification_status = 'qualified';
          logActivity({
            actorType: 'system',
            action: 'ba_landlord_qualified',
            targetType: 'landlord',
            targetId: landlord.id,
            metadata: { baId: landlord.ba_id, trigger: 'first_payment_manual' },
          });
        }
      }

      if (subPaymentRow) {
        await recordCommissionForPayment({
          id: subPaymentRow.id,
          landlord_id: landlord.id,
          amount: record.amount_paid,
          paid_at: paidAtIso,
        });
      }
    } else {
      let currentExpiry = landlord.subscription_expires_at ? new Date(landlord.subscription_expires_at) : new Date();
      if (currentExpiry < new Date()) currentExpiry = new Date();
      currentExpiry.setMonth(currentExpiry.getMonth() + record.period_months);
      await supabase
        .from('landlords')
        .update({
          subscription_expires_at: currentExpiry.toISOString(),
          subscription_status: 'active',
          unit_limit: record.units_count,
          subscription_period_months: record.period_months,
          subscription_started_at: new Date().toISOString(),
        })
        .eq('id', landlord.id);
      await applyUnitLimitChange({ landlordId: landlord.id, newLimit: record.units_count, actorType: 'admin', actorId: req.user.id });
      if (landlord.email) {
        await sendEmail(
          landlord.email,
          'Your RentaPay subscription has been renewed',
          wrapEmailHtml(templates.subscriptionRenewed(currentExpiry.toLocaleDateString('en-GB')))
        );
      }

      // ONE-TIME DISCOUNT CONSUMPTION: this manual payment is being
      // CONFIRMED right now by the admin - the discount captured at
      // submission time (record.loyalty_discount_id) is deactivated
      // here so it doesn't apply again on the landlord's next renewal.
      // A rejected/pending record never reaches this branch, so an
      // unconfirmed submission never costs the landlord their discount.
      if (record.loyalty_discount_id) {
        await consumeLoyaltyDiscount(record.loyalty_discount_id, { manualPaymentId: record.id });
      }
    }

    await supabase
      .from('landlord_manual_subscription_payments')
      .update({ status: 'confirmed', actioned_by_admin_id: adminIdOrNull(req.user.id), confirmed_or_rejected_at: new Date().toISOString() })
      .eq('id', id);

    await notify('landlord', landlord.id, landlord.phone, 'Your manual subscription payment was confirmed. Your account is now active.', { category: 'account', title: 'Payment Confirmed', urgent: true, propertyId: record.property_id || null });

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'landlord_manual_subscription_payment_confirmed', targetType: 'landlord_manual_subscription_payment', targetId: id });

    return res.json({ message: 'Confirmed.' });
  } catch (err) {
    logger.error('[landlordManualSubscriptionPayment] confirm error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to confirm payment.' });
  }
}

async function rejectManualSubscriptionPayment(req, res) {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data: record, error: fetchErr } = await supabase
      .from('landlord_manual_subscription_payments')
      .select('*, landlords!landlord_manual_subscription_payments_landlord_id_fkey(phone)')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!record) return res.status(404).json({ error: 'Payment record not found.' });
    if (record.status !== 'pending') return res.status(400).json({ error: `Already ${record.status}.` });

    await supabase
      .from('landlord_manual_subscription_payments')
      .update({ status: 'rejected', actioned_by_admin_id: adminIdOrNull(req.user.id), confirmed_or_rejected_at: new Date().toISOString(), rejection_reason: reason || null })
      .eq('id', id);

    if (record.landlords?.phone) {
      await notify('landlord', record.landlord_id, record.landlords.phone, `Your manual subscription payment (ref ${record.transaction_code}) could not be verified${reason ? `: ${reason}` : '.'} Please try again or contact support.`, { category: 'account', title: 'Payment Not Confirmed', urgent: true, propertyId: record.property_id || null });
    }

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'landlord_manual_subscription_payment_rejected', targetType: 'landlord_manual_subscription_payment', targetId: id, metadata: { reason } });

    return res.json({ message: 'Rejected.' });
  } catch (err) {
    logger.error('[landlordManualSubscriptionPayment] reject error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to reject payment.' });
  }
}

async function deleteManualSubscriptionPayment(req, res) {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('landlord_manual_subscription_payments').delete().eq('id', id);
    if (error) throw error;
    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'landlord_manual_subscription_payment_deleted', targetType: 'landlord_manual_subscription_payment', targetId: id });
    return res.json({ message: 'Deleted.' });
  } catch (err) {
    logger.error('[landlordManualSubscriptionPayment] delete error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to delete record.' });
  }
}

module.exports = {
  submitManualSubscriptionPayment,
  getMyLatestManualSubscriptionPayment,
  listManualSubscriptionPayments,
  confirmManualSubscriptionPayment,
  rejectManualSubscriptionPayment,
  deleteManualSubscriptionPayment,
  submitRegistrationManualPayment,
  checkRegistrationManualPaymentStatus,
};

// ---------------------------------------------------------------------
// REGISTRATION-TIME manual payment (direct request: "there should be a
// UI for manual payment that when opened gives instructions to pay on
// paybill 522522 acct 1341657388, the exact amount they were to pay -
// at the moment there is no manual entering of payment"). Until now
// the ONLY way to pay during signup was the STK push - if it failed,
// was delayed, or never arrived (Daraja sandbox issues, wrong network,
// etc.), there was no fallback at all during registration, unlike
// every other payment flow in the app which already has one.
//
// No JWT exists at this point in the flow - registerLandlord only
// returns a landlordId, not a token (the token only gets issued after
// payment is confirmed and the wizard auto-logs in - see
// activateLandlordAfterPayment / RegisterFlow.jsx's
// proceedAfterVerification). So this is public like the STK
// checkoutRequestId poll right above submitManualSubscriptionPayment - but a landlordId is
// guessable (they're sequential-ish UUIDs, not secret), so this is
// additionally gated to only ever act on a landlord who is still
// genuinely 'pending' (i.e. mid-signup, not yet activated). Nothing
// here activates the account automatically either way - an admin
// still has to review and confirm it in landlord_manual_subscription_
// payments, exactly like every other manual payment in the app.
// ---------------------------------------------------------------------
async function submitRegistrationManualPayment(req, res) {
  try {
    const { landlordId, transactionCode, amountPaid, mpesaPayerName, mpesaPayerPhone, mpesaSmsTimestamp } = req.body;
    if (!landlordId || !transactionCode || amountPaid == null || !mpesaPayerName || !mpesaPayerPhone) {
      return res.status(400).json({ error: 'landlordId, transactionCode, amountPaid, mpesaPayerName, and mpesaPayerPhone are required.' });
    }

    const { data: landlord } = await supabase.from('landlords').select('id, subscription_status, unit_limit, subscription_period_months').eq('id', landlordId).maybeSingle();
    if (!landlord) return res.status(404).json({ error: 'Registration not found. Please start signup again.' });
    if (landlord.subscription_status !== 'pending') {
      return res.status(400).json({ error: 'This account is already active - no payment needed here.' });
    }

    const normalizedPhone = normalizePhone(mpesaPayerPhone);
    if (!normalizedPhone) return res.status(400).json({ error: 'mpesaPayerPhone must be a valid phone number.' });
    const validatedAmount = validatePositiveAmount(amountPaid);
    if (validatedAmount === null) return res.status(400).json({ error: 'amountPaid must be a valid positive number.' });

    const normalizedTxCode = String(transactionCode).trim().toUpperCase();
    const { data: existingConfirmed } = await supabase
      .from('landlord_manual_subscription_payments')
      .select('id')
      .eq('transaction_code', normalizedTxCode)
      .eq('status', 'confirmed')
      .order('confirmed_or_rejected_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // P1: same expected-amount capture as the post-signup manual
    // payment path - registration pricing is already locked in on the
    // landlord row (unit_limit/subscription_period_months) at this
    // point, so recompute against those rather than anything the
    // caller sent.
    let expectedAmount = null;
    try {
      const quote = await calculateSubscriptionCost(landlord.unit_limit, landlord.subscription_period_months || 1, landlordId);
      expectedAmount = quote.totalCost;
    } catch (quoteErr) {
      logger.warn('[landlordManualSubscriptionPayment] failed to compute registration expected amount:', quoteErr.message);
    }

    const { data: record, error: insertErr } = await supabase
      .from('landlord_manual_subscription_payments')
      .insert({
        landlord_id: landlordId,
        submitted_by_role: 'landlord',
        submitted_by_landlord_id: landlordId,
        transaction_code: normalizedTxCode,
        amount_paid: validatedAmount,
        expected_amount: expectedAmount,
        mpesa_payer_name: String(mpesaPayerName).trim(),
        mpesa_payer_phone: normalizedPhone,
        mpesa_sms_timestamp: mpesaSmsTimestamp || null,
        period_months: landlord.subscription_period_months || 1,
        units_count: landlord.unit_limit,
        duplicate_of: existingConfirmed ? existingConfirmed.id : null,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    logActivity({
      actorType: 'landlord',
      actorId: landlordId,
      action: 'landlord_registration_manual_payment_submitted',
      targetType: 'landlord_manual_subscription_payment',
      targetId: record.id,
      metadata: { landlordId, amountPaid: validatedAmount, isDuplicate: !!existingConfirmed },
    });

    return res.status(201).json({
      message: existingConfirmed
        ? 'This transaction code was already used for a previous confirmed payment. This has been flagged for the admin to review.'
        : 'Submitted. Your payment will be reviewed and your account activated shortly.',
      isDuplicate: !!existingConfirmed,
      confirmationId: record.id,
    });
  } catch (err) {
    logger.error('[landlordManualSubscriptionPayment] submitRegistrationManualPayment error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit payment.' });
  }
}

// Polled by the registration screen (same pattern as
// checkSubscriptionPaymentStatus for the STK path) to detect once an
// admin has confirmed the manual submission and move on into the
// account automatically, without the person needing to refresh anything.
async function checkRegistrationManualPaymentStatus(req, res) {
  try {
    const { landlordId } = req.params;
    const { data: landlord } = await supabase.from('landlords').select('subscription_status').eq('id', landlordId).maybeSingle();
    if (!landlord) return res.status(404).json({ error: 'Registration not found.' });
    if (landlord.subscription_status !== 'pending') {
      // PERMANENT FIX (same root cause as payment.controller.js's
      // tokenForActivatedLandlord - manual review is the SLOWEST of
      // the two payment paths, "a few minutes to a few hours", making
      // it the likeliest one to outlive form.password sitting in
      // React state). Mint the token here instead of asking the
      // frontend to log back in with a password that's had hours to
      // vanish from memory.
      return res.json({ status: 'completed', token: signToken({ id: landlordId, role: 'landlord' }) });
    }
    const { data: latest } = await supabase
      .from('landlord_manual_subscription_payments')
      .select('status')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest) return res.json({ status: 'none' }); // no manual payment submitted yet - don't tell the frontend "pending"
    if (latest.status === 'rejected') return res.json({ status: 'rejected' });
    return res.json({ status: 'pending' });
  } catch (err) {
    logger.error('[landlordManualSubscriptionPayment] checkRegistrationManualPaymentStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to check payment status.' });
  }
}
