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
const { applyUnitLimitChange } = require('../utils/unitLimitEnforcement');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const templates = require('../services/notificationTemplates');
const { PLATFORM_PAYBILL_NUMBER, PLATFORM_PAYBILL_ACCOUNT_NUMBER } = require('../constants/platformPaybill');

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

// ---------------------------------------------------------------------
// LANDLORD/MANAGER/CARETAKER: submit proof of a manual payment made
// directly to RentaPay's platform paybill (no Daraja/STK involved).
// ---------------------------------------------------------------------
async function submitManualSubscriptionPayment(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId, transactionCode, amountPaid, mpesaPayerName, mpesaPayerPhone, mpesaSmsTimestamp, periodMonths, unitsCount } = req.body;

    if (!transactionCode || amountPaid == null || !mpesaPayerName || !mpesaPayerPhone || !unitsCount) {
      return res.status(400).json({ error: 'transactionCode, amountPaid, mpesaPayerName, mpesaPayerPhone, and unitsCount are required.' });
    }
    const normalizedPhone = normalizePhone(mpesaPayerPhone);
    if (!normalizedPhone) return res.status(400).json({ error: 'mpesaPayerPhone must be a valid phone number.' });
    const validatedAmount = validatePositiveAmount(amountPaid);
    if (validatedAmount === null) return res.status(400).json({ error: 'amountPaid must be a valid positive number.' });

    const role = req.user.role; // 'landlord' | 'manager' | 'caretaker' (roleLevel distinguishes manager/caretaker on the same table)
    const submittedByRole = role === 'landlord' ? 'landlord' : (req.user.roleLevel === 'caretaker' ? 'caretaker' : 'manager');

    // FIX (direct request: "a landlord or scout can decide to submit
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

    const { data: record, error: insertErr } = await supabase
      .from('landlord_manual_subscription_payments')
      .insert({
        landlord_id: landlordId,
        property_id: propertyId || null,
        submitted_by_role: submittedByRole,
        submitted_by_landlord_id: role === 'landlord' ? req.user.id : null,
        submitted_by_manager_id: role !== 'landlord' ? req.user.id : null,
        transaction_code: normalizedTxCode,
        amount_paid: validatedAmount,
        mpesa_payer_name: String(mpesaPayerName).trim(),
        mpesa_payer_phone: normalizedPhone,
        mpesa_sms_timestamp: mpesaSmsTimestamp || null,
        period_months: Number(periodMonths) || 1,
        units_count: Number(unitsCount),
        duplicate_of: existingConfirmed ? existingConfirmed.id : null,
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
    // payment submissions for scouts and landlords"): now that admin
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
    ).catch((notifyErr) => console.warn('[landlordManualSubscriptionPayment] admin notify failed:', notifyErr.message));

    return res.status(201).json({
      message: existingConfirmed
        ? 'This transaction code was already used for a previous confirmed payment and cannot be reused. This has been flagged for the admin to review - please contact support if you believe this is a mistake.'
        : 'Submitted. Your payment will be reviewed and your subscription updated shortly.',
      isDuplicate: !!existingConfirmed,
      confirmation: record,
      paybillNumber: PLATFORM_PAYBILL_NUMBER,
      accountNumber: PLATFORM_PAYBILL_ACCOUNT_NUMBER,
    });
  } catch (err) {
    console.error('[landlordManualSubscriptionPayment] submit error:', err.message);
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
    console.error('[landlordManualSubscriptionPayment] getMyLatest error:', err.message);
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
    return res.json(data || []);
  } catch (err) {
    console.error('[landlordManualSubscriptionPayment] list error:', err.message);
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

    if (record.property_id) {
      // Renewing/activating one specific apartment's own clock.
      const now = new Date();
      const expiry = new Date(now);
      expiry.setMonth(expiry.getMonth() + record.period_months);
      await supabase
        .from('properties')
        .update({
          unit_limit: record.units_count,
          subscription_period_months: record.period_months,
          subscription_started_at: now.toISOString(),
          subscription_expires_at: expiry.toISOString(),
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
    }

    await supabase
      .from('landlord_manual_subscription_payments')
      .update({ status: 'confirmed', actioned_by_admin_id: adminIdOrNull(req.user.id), confirmed_or_rejected_at: new Date().toISOString() })
      .eq('id', id);

    await notify('landlord', landlord.id, landlord.phone, 'Your manual subscription payment was confirmed. Your account is now active.', { category: 'account', title: 'Payment Confirmed', urgent: true, propertyId: record.property_id || null });

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'landlord_manual_subscription_payment_confirmed', targetType: 'landlord_manual_subscription_payment', targetId: id });

    return res.json({ message: 'Confirmed.' });
  } catch (err) {
    console.error('[landlordManualSubscriptionPayment] confirm error:', err.message);
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
    console.error('[landlordManualSubscriptionPayment] reject error:', err.message);
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
    console.error('[landlordManualSubscriptionPayment] delete error:', err.message);
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

    const { data: record, error: insertErr } = await supabase
      .from('landlord_manual_subscription_payments')
      .insert({
        landlord_id: landlordId,
        submitted_by_role: 'landlord',
        submitted_by_landlord_id: landlordId,
        transaction_code: normalizedTxCode,
        amount_paid: validatedAmount,
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
    console.error('[landlordManualSubscriptionPayment] submitRegistrationManualPayment error:', err.message);
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
      return res.json({ status: 'completed' });
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
    console.error('[landlordManualSubscriptionPayment] checkRegistrationManualPaymentStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to check payment status.' });
  }
}
