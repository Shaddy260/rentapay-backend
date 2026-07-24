// src/controllers/scout.controller.js
//
// Phase 4 of the Scout role rollout: registration (phone -> OTP verify
// -> set password), county selection + payment (STK push, with a
// manual-Paybill fallback identical in spirit to
// landlordManualSubscriptionPayment.controller.js), and the Scout's
// own view of their per-county subscriptions.
//
// SCOUT EXCLUSIVITY: a Scout account must be fully exclusive - a Scout
// can only be a Scout, never also a landlord/manager/tenant on the
// same phone number. (This reverses the original Phase 1-4 design,
// which deliberately allowed a phone to hold both a Scout account and
// a landlord/manager/tenant account, disambiguated at login by the
// dual-role account picker - that picker still exists for
// landlord/manager combos elsewhere, but a fresh Scout registration
// now goes through the same shared findPhoneConflict() every other
// role uses, so a phone already registered to a landlord/manager/
// active tenant is rejected up front, and vice versa.)

const supabase = require('../config/supabase');
const { hashPassword, validatePasswordStrength } = require('../utils/password');
const { generateOTP, getOTPExpiry } = require('../utils/otp');
const { normalizePhoneOrThrow, normalizePhone } = require('../utils/phone');
const { isValidEmail } = require('../utils/email');
const { initiateSTKPush } = require('../services/daraja.service');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const { notify } = require('../services/notify.service');
const templates = require('../services/notificationTemplates');
const { logActivity } = require('../services/activityLog.service');
const { validatePositiveAmount } = require('../utils/validateAmount');
const { PLATFORM_PAYBILL_NUMBER, PLATFORM_PAYBILL_ACCOUNT_NUMBER } = require('../constants/platformPaybill');
const { KENYA_COUNTIES } = require('../constants/kenyaCounties');
const { findPhoneConflict } = require('../utils/phoneUniqueness');
const { checkLandlordOwnership } = require('../middleware/auth.middleware');
const { sendPushToRecipient } = require('../services/webpush.service');
const scoutReferralService = require('../services/scoutReferral.service');

// Same "admin acting id might be the hardcoded super-admin string, not
// a real uuid" fix as landlordManualSubscriptionPayment.controller.js -
// reused verbatim so the two admin-review flows behave identically.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function adminIdOrNull(id) {
  return UUID_RE.test(id || '') ? id : null;
}

// ---------------------------------------------------------------------
// PUBLIC: county list + tiered pricing, shown on the /scout landing
// page BEFORE the person has an account or a token - so this is
// deliberately unauthenticated, same as the pricing shown on the
// landlord signup page.
// ---------------------------------------------------------------------
async function getCountyPricing(req, res) {
  try {
    const { data: tiers, error } = await supabase.from('county_pricing_tiers').select('*').order('tier').order('county');
    if (error) throw error;

    // If Phase 1/4's SQL hasn't been run against this environment yet
    // (or a county was added to KENYA_COUNTIES without a matching
    // pricing row), surface that clearly instead of quietly showing a
    // shorter list than the real 47 counties - a missing tier row is a
    // migration bug worth noticing, not silently hiding a county from
    // Scouts trying to subscribe to it.
    const priced = new Set((tiers || []).map((t) => t.county));
    const missing = KENYA_COUNTIES.filter((c) => !priced.has(c));
    if (missing.length > 0) {
      console.warn('[scout] getCountyPricing: counties missing a pricing row (check add-scout-payments.sql was run):', missing.join(', '));
    }

    return res.json({ counties: tiers || [] });
  } catch (err) {
    console.error('[scout] getCountyPricing error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch county pricing.' });
  }
}

// ---------------------------------------------------------------------
// STEP 1 — sign-up: fullName + phone + password, then send an OTP.
// Mirrors registerLandlord's phone-normalize -> hash -> insert -> OTP
// shape, minus the payment (that's a separate step for Scouts - see
// §3 of the sign-up flow: OTP verify happens BEFORE payment, not
// after, unlike landlord registration).
// ---------------------------------------------------------------------
async function registerScout(req, res) {
  try {
    let { fullName, phone, email, password } = req.body;

    if (!fullName || !phone || !email || !password) {
      return res.status(400).json({ error: 'fullName, phone, email, and password are required.' });
    }
    email = email.trim();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    try {
      phone = normalizePhoneOrThrow(phone, 'Phone number');
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    const { isValid, errors } = validatePasswordStrength(password, { phone, name: fullName });
    if (!isValid) {
      return res.status(400).json({ error: 'Weak password.', details: errors });
    }

    // Same stale-attempt cleanup as registerLandlord, and MUST run
    // before the cross-table exclusivity check below - otherwise an
    // old unverified row of this Scout's own would make
    // findPhoneConflict('scout') falsely report "already exists".
    const { data: existing } = await supabase.from('scouts').select('id, is_verified').eq('phone', phone).maybeSingle();
    if (existing) {
      if (existing.is_verified) {
        return res.status(409).json({ error: 'A Scout account with this phone number already exists.' });
      }
      // An unverified row means a previous sign-up attempt never
      // finished OTP verify - delete it and let this attempt proceed
      // rather than permanently locking the number out.
      await supabase.from('scouts').delete().eq('id', existing.id);
    }

    // Exclusivity check, against every other role's table (see header
    // comment) - a phone already used by a landlord/manager/active
    // tenant can't also become a Scout, and vice versa.
    const conflict = await findPhoneConflict(phone, 'scout');
    if (conflict) {
      return res.status(409).json({ error: conflict });
    }

    const passwordHash = await hashPassword(password);
    const otp = generateOTP();
    const otpExpiresAt = getOTPExpiry();

    const { data: scout, error } = await supabase
      .from('scouts')
      .insert({
        full_name: fullName,
        phone,
        email,
        password_hash: passwordHash,
        otp_code: otp,
        otp_expires_at: otpExpiresAt.toISOString(),
        is_verified: false,
      })
      .select()
      .single();

    if (error) throw error;

    try {
      await sendEmail(email, 'Your RentaPay Scout verification code', wrapEmailHtml(templates.otpMessage(otp)));
    } catch (emailErr) {
      console.error('[scout] registerScout: CRITICAL - OTP email failed to send:', emailErr.message);
    }

    logActivity({ actorType: 'system', action: 'scout_registration_initiated', targetType: 'scout', targetId: scout.id });

    // accountId + accountType match the shape verifyOTP/resendOTP
    // already expect (both were widened in Phase 2/3 to accept
    // 'scout') - the frontend reuses the exact same OTP-entry screen
    // pattern as landlord/tenant registration.
    return res.status(201).json({
      message: 'Registered. Enter the code we sent to your email to verify your account.',
      accountId: scout.id,
      accountType: 'scout',
      phone,
    });
  } catch (err) {
    console.error('[scout] registerScout error:', err.message);
    return res.status(500).json({ error: 'Failed to register.' });
  }
}

// ---------------------------------------------------------------------
// STEP 3 — county selection + payment (STK push path). Requires a
// verified, logged-in Scout (req.user.role === 'scout', enforced by
// the route's requireRole middleware) - OTP verify (step 2, reusing
// verifyOTP) and a normal login (reusing login()) happen in between,
// with no new endpoints needed for either.
// ---------------------------------------------------------------------
async function subscribeCounties(req, res) {
  try {
    const scoutId = req.user.id;
    const { counties } = req.body;

    if (!Array.isArray(counties) || counties.length === 0) {
      return res.status(400).json({ error: 'counties must be a non-empty array.' });
    }
    const uniqueCounties = [...new Set(counties)];

    const { data: tiers, error: tiersErr } = await supabase.from('county_pricing_tiers').select('*').in('county', uniqueCounties);
    if (tiersErr) throw tiersErr;

    if (tiers.length !== uniqueCounties.length) {
      const known = new Set(tiers.map((t) => t.county));
      const unknown = uniqueCounties.filter((c) => !known.has(c));
      return res.status(400).json({ error: `Unknown county name(s): ${unknown.join(', ')}` });
    }

    const totalCost = tiers.reduce((sum, t) => sum + Number(t.annual_price), 0);

    // M-Pesa STK Push rejects any single transaction over KES 150,000
    // (Safaricom's hard per-transaction ceiling). This is EXACTLY why
    // picking "many counties" failed: with prices up to 4,000/county,
    // enough counties in one go pushes totalCost past that ceiling and
    // Daraja's API rejects the whole request outright (previously
    // surfaced only as an opaque "Could not initiate M-Pesa payment"
    // 502). Catch this before ever calling Daraja, with a clear,
    // actionable message instead.
    const MPESA_MAX_TRANSACTION_AMOUNT = 150000;
    if (totalCost > MPESA_MAX_TRANSACTION_AMOUNT) {
      return res.status(400).json({
        error: `That selection totals KES ${totalCost.toLocaleString()}, which is above M-Pesa's KES ${MPESA_MAX_TRANSACTION_AMOUNT.toLocaleString()} limit per transaction. Please select fewer counties and pay in more than one batch.`,
      });
    }

    const { data: scout, error: scoutErr } = await supabase.from('scouts').select('id, phone, full_name').eq('id', scoutId).maybeSingle();
    if (scoutErr || !scout) return res.status(404).json({ error: 'Scout account not found.' });

    let stkResponse;
    try {
      stkResponse = await initiateSTKPush({
        phoneNumber: scout.phone,
        amount: totalCost,
        accountReference: `RENTAPAY-SCOUT-${scout.id.slice(0, 8)}`,
        // Daraja's TransactionDesc field is only reliably accepted up
        // to ~13 characters - the old code built this string out of
        // every selected county name, so it grew unbounded (and
        // invalid) the more counties were picked. Use a short, fixed
        // description instead; the real detail (which counties, for
        // which scout) already lives in scout_county_payments.
        transactionDesc: 'Scout Areas',
      });
    } catch (stkErr) {
      console.error('[scout] subscribeCounties: STK push failed:', stkErr.message);
      return res.status(502).json({ error: 'Could not initiate M-Pesa payment. Please try again.', details: stkErr.message });
    }

    const { error: paymentErr } = await supabase.from('scout_county_payments').insert({
      scout_id: scout.id,
      counties: uniqueCounties,
      amount: totalCost,
      mpesa_checkout_request_id: stkResponse.CheckoutRequestID,
      status: 'pending',
    });

    if (paymentErr) {
      // Same reasoning as registerLandlord's equivalent case: the STK
      // prompt has already gone out to the person's phone at this
      // point, so we don't roll anything back - just log loudly so
      // this gets investigated even though the callback will have
      // nothing to match against.
      console.error('[scout] CRITICAL: STK push succeeded but failed to record scout_county_payments row:', paymentErr.message, '- checkoutRequestId:', stkResponse.CheckoutRequestID, '- scoutId:', scout.id);
    }

    return res.json({
      message: 'Check your phone to complete payment.',
      checkoutRequestId: stkResponse.CheckoutRequestID,
      amount: totalCost,
      counties: uniqueCounties,
    });
  } catch (err) {
    console.error('[scout] subscribeCounties error:', err.message);
    return res.status(500).json({ error: 'Failed to start payment.' });
  }
}

// Called from payment.controller.js's handleSTKCallback dispatcher,
// same shape as processSubscriptionPaymentCallback/
// processPropertyPaymentCallback.
async function processScoutCountyPaymentCallback(payment, resultCode, callbackMetadata) {
  if (resultCode !== 0) {
    await supabase.from('scout_county_payments').update({ status: 'failed' }).eq('id', payment.id);
    return;
  }

  const extractMetadataValue = (name) => {
    const item = callbackMetadata?.Item?.find((i) => i.Name === name);
    return item ? item.Value : null;
  };
  const mpesaReceiptNumber = extractMetadataValue('MpesaReceiptNumber');
  const phoneNumber = extractMetadataValue('PhoneNumber');

  await supabase
    .from('scout_county_payments')
    .update({
      status: 'completed',
      mpesa_transaction_id: mpesaReceiptNumber,
      mpesa_phone: phoneNumber ? String(phoneNumber) : null,
      paid_at: new Date().toISOString(),
    })
    .eq('id', payment.id);

  await activateScoutCounties(payment.scout_id, payment.counties);

  logActivity({ actorType: 'system', action: 'scout_county_payment_completed', targetType: 'scout', targetId: payment.scout_id, metadata: { counties: payment.counties, mpesaReceiptNumber } });
}

// Shared activation logic (STK callback + admin manual-payment
// confirm both call this): one row per (scout, county) in
// scout_county_subscriptions, each with its OWN year-long expiry -
// per Phase 1's schema comment, a Scout adding Kiambu in June must
// not have its clock reset to match a Nairobi subscription bought in
// January. Renewing an already-active county EXTENDS from its current
// expiry (or from now, if it had already lapsed) rather than always
// resetting to exactly one year from today.
async function activateScoutCounties(scoutId, counties) {
  const { data: existingRows } = await supabase.from('scout_county_subscriptions').select('*').eq('scout_id', scoutId).in('county', counties);
  const existingByCounty = new Map((existingRows || []).map((r) => [r.county, r]));

  const now = new Date();

  await Promise.all(
    counties.map((county) => {
      const existing = existingByCounty.get(county);
      let expiresAt;
      if (existing && new Date(existing.expires_at) > now) {
        expiresAt = new Date(existing.expires_at);
      } else {
        expiresAt = new Date(now);
      }
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);

      return supabase.from('scout_county_subscriptions').upsert(
        {
          scout_id: scoutId,
          county,
          started_at: existing ? existing.started_at : now.toISOString(),
          expires_at: expiresAt.toISOString(),
          status: 'active',
        },
        { onConflict: 'scout_id,county' }
      );
    })
  );
}

// ---------------------------------------------------------------------
// Manual Paybill fallback - "didn't get the STK popup" - same review
// flow as landlordManualSubscriptionPayment.controller.js.
// ---------------------------------------------------------------------
async function submitManualCountyPayment(req, res) {
  try {
    const scoutId = req.user.id;
    const { counties, transactionCode, amountPaid, mpesaPayerName, mpesaPayerPhone, mpesaSmsTimestamp } = req.body;

    if (!Array.isArray(counties) || counties.length === 0 || !transactionCode || amountPaid == null || !mpesaPayerName || !mpesaPayerPhone) {
      return res.status(400).json({ error: 'counties, transactionCode, amountPaid, mpesaPayerName, and mpesaPayerPhone are required.' });
    }
    const normalizedPhone = normalizePhone(mpesaPayerPhone);
    if (!normalizedPhone) return res.status(400).json({ error: 'mpesaPayerPhone must be a valid phone number.' });
    const validatedAmount = validatePositiveAmount(amountPaid);
    if (validatedAmount === null) return res.status(400).json({ error: 'amountPaid must be a valid positive number.' });

    const uniqueCounties = [...new Set(counties)];

    // FIX (direct request: same reused-code flagging as the tenant and
    // landlord manual payment flows above).
    const normalizedTxCode = String(transactionCode).trim().toUpperCase();
    const { data: existingConfirmed } = await supabase
      .from('scout_manual_county_payments')
      .select('id')
      .eq('transaction_code', normalizedTxCode)
      .eq('status', 'confirmed')
      .order('confirmed_or_rejected_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: record, error: insertErr } = await supabase
      .from('scout_manual_county_payments')
      .insert({
        scout_id: scoutId,
        counties: uniqueCounties,
        amount_paid: validatedAmount,
        transaction_code: normalizedTxCode,
        mpesa_payer_name: String(mpesaPayerName).trim(),
        mpesa_payer_phone: normalizedPhone,
        mpesa_sms_timestamp: mpesaSmsTimestamp || null,
        duplicate_of: existingConfirmed ? existingConfirmed.id : null,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    logActivity({ actorType: 'scout', actorId: scoutId, action: 'scout_manual_county_payment_submitted', targetType: 'scout_manual_county_payment', targetId: record.id, metadata: { counties: uniqueCounties, amountPaid: validatedAmount, isDuplicate: !!existingConfirmed } });

    // Same admin notify() upgrade as the landlord manual-payment path
    // - direct request: "in admin also should be notified on payment
    // submissions for scouts and landlords".
    notify(
      'admin',
      'super-admin',
      process.env.SUPER_ADMIN_PHONE,
      `New scout manual payment submitted (KES ${validatedAmount}, code ${normalizedTxCode}, ${uniqueCounties.join(', ')})${existingConfirmed ? ' - DUPLICATE transaction code, flagged' : ''}. Review in the admin panel.`,
      { category: 'account', title: 'Manual Payment Submitted' }
    ).catch((notifyErr) => console.warn('[scout] submitManualCountyPayment admin notify failed:', notifyErr.message));

    return res.status(201).json({
      message: existingConfirmed
        ? 'This transaction code was already used for a previous confirmed payment and cannot be reused. This has been flagged for the admin to review.'
        : 'Submitted. Your payment will be reviewed and your subscription updated shortly.',
      isDuplicate: !!existingConfirmed,
      confirmation: record,
      paybillNumber: PLATFORM_PAYBILL_NUMBER,
      accountNumber: PLATFORM_PAYBILL_ACCOUNT_NUMBER,
    });
  } catch (err) {
    console.error('[scout] submitManualCountyPayment error:', err.message);
    return res.status(500).json({ error: 'Failed to submit payment.' });
  }
}

async function getMyLatestManualCountyPayment(req, res) {
  try {
    const { data, error } = await supabase
      .from('scout_manual_county_payments')
      .select('*')
      .eq('scout_id', req.user.id)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return res.json(data || null);
  } catch (err) {
    console.error('[scout] getMyLatestManualCountyPayment error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch payment status.' });
  }
}

// ---------------------------------------------------------------------
// ADMIN: list / confirm / reject / delete manual county payments
// ---------------------------------------------------------------------
async function listManualCountyPayments(req, res) {
  try {
    const status = req.query.status || 'pending';
    // PERF: no cap here used to mean this query got a little slower
    // with every payment RentaPay has ever processed, forever. The
    // admin queue only ever needs to act on recent/pending items, so
    // cap it - raise this if a legitimate "see everything historical"
    // view is ever needed, ideally with real pagination instead.
    let query = supabase.from('scout_manual_county_payments').select('*, scouts(full_name, phone)').order('submitted_at', { ascending: false }).limit(500);
    if (status !== 'all') query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    console.error('[scout] listManualCountyPayments error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch payments.' });
  }
}

async function confirmManualCountyPayment(req, res) {
  try {
    const { id } = req.params;
    const { data: record, error: fetchErr } = await supabase.from('scout_manual_county_payments').select('*, scouts(*)').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!record) return res.status(404).json({ error: 'Payment record not found.' });
    if (record.status !== 'pending') return res.status(400).json({ error: `Already ${record.status}.` });

    await activateScoutCounties(record.scout_id, record.counties);

    await supabase
      .from('scout_manual_county_payments')
      .update({ status: 'confirmed', actioned_by_admin_id: adminIdOrNull(req.user.id), confirmed_or_rejected_at: new Date().toISOString() })
      .eq('id', id);

    if (record.scouts?.email) {
      await sendEmail(
        record.scouts.email,
        'Your RentaPay Scout payment was confirmed',
        wrapEmailHtml(`Your RentaPay Scout payment for ${record.counties.join(', ')} was confirmed. Your subscription is now active.`)
      );
    }

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'scout_manual_county_payment_confirmed', targetType: 'scout_manual_county_payment', targetId: id });

    return res.json({ message: 'Confirmed.' });
  } catch (err) {
    console.error('[scout] confirmManualCountyPayment error:', err.message);
    return res.status(500).json({ error: 'Failed to confirm payment.' });
  }
}

async function rejectManualCountyPayment(req, res) {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data: record, error: fetchErr } = await supabase.from('scout_manual_county_payments').select('*, scouts(email)').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!record) return res.status(404).json({ error: 'Payment record not found.' });
    if (record.status !== 'pending') return res.status(400).json({ error: `Already ${record.status}.` });

    await supabase
      .from('scout_manual_county_payments')
      .update({ status: 'rejected', actioned_by_admin_id: adminIdOrNull(req.user.id), confirmed_or_rejected_at: new Date().toISOString(), rejection_reason: reason || null })
      .eq('id', id);

    if (record.scouts?.email) {
      await sendEmail(
        record.scouts.email,
        'Your RentaPay Scout payment could not be verified',
        wrapEmailHtml(`Your RentaPay Scout payment (ref ${record.transaction_code}) could not be verified${reason ? `: ${reason}` : '.'} Please try again or contact support.`)
      );
    }

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'scout_manual_county_payment_rejected', targetType: 'scout_manual_county_payment', targetId: id, metadata: { reason } });

    return res.json({ message: 'Rejected.' });
  } catch (err) {
    console.error('[scout] rejectManualCountyPayment error:', err.message);
    return res.status(500).json({ error: 'Failed to reject payment.' });
  }
}

async function deleteManualCountyPayment(req, res) {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('scout_manual_county_payments').delete().eq('id', id);
    if (error) throw error;
    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'scout_manual_county_payment_deleted', targetType: 'scout_manual_county_payment', targetId: id });
    return res.json({ message: 'Deleted.' });
  } catch (err) {
    console.error('[scout] deleteManualCountyPayment error:', err.message);
    return res.status(500).json({ error: 'Failed to delete record.' });
  }
}

// ---------------------------------------------------------------------
// Scout's own view of their subscriptions (Phase 6's "My
// Subscriptions" tab reads from this).
//
// FIX: this used to respond with `{ profile: {...} }`, but the
// frontend (ScoutPortal.jsx) calls api.getMyScoutProfile(token) and
// reads the result directly as scoutProfile.full_name /
// scoutProfile.phone - there was never a matching `.profile` unwrap on
// the frontend, so those fields were always undefined (silently -
// the request "succeeded", it just handed back a shape nothing used).
// Responding with the fields at the top level, same shape
// getMyLandlordProfile/tenant getProfile already use, fixes that.
// ---------------------------------------------------------------------
async function getMyProfile(req, res) {
  try {
    const scoutId = req.user.id;

    const { data: scout, error } = await supabase
      .from('scouts')
      .select('id, full_name, phone, email, photo_url, bio, is_verified, created_at, onboarding_dismissed_at')
      .eq('id', scoutId)
      .maybeSingle();

    if (error) {
      console.error('[scout] getMyProfile query error for scoutId', scoutId, ':', error.message);
      return res.status(500).json({ error: `Failed to load profile: ${error.message}` });
    }
    if (!scout) return res.status(404).json({ error: 'Scout not found.' });

    return res.json(scout);
  } catch (err) {
    console.error('[scout] getMyProfile error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch profile.' });
  }
}

// ---------------------------------------------------------------------
// Direct request: scouts should "be able to set their own profile...
// like in others" - the missing write side of getMyProfile above.
// Phone is intentionally NOT editable here: it's the scout's login
// identifier and changing it free-form would need the same
// re-verification flow phone-change already goes through for
// landlords/tenants, which is out of scope for a simple profile edit.
// ---------------------------------------------------------------------
async function updateMyContact(req, res) {
  try {
    const scoutId = req.user.id;
    const { fullName, email, bio } = req.body;

    const updates = {};
    if (fullName !== undefined) {
      if (!String(fullName).trim()) return res.status(400).json({ error: 'Full name cannot be empty.' });
      updates.full_name = String(fullName).trim();
    }
    if (email !== undefined) updates.email = email ? String(email).trim() : null;
    if (bio !== undefined) updates.bio = bio ? String(bio).trim() : null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { data: scout, error } = await supabase
      .from('scouts')
      .update(updates)
      .eq('id', scoutId)
      .select('id, full_name, phone, email, photo_url, bio')
      .single();
    if (error) throw error;

    logActivity({ actorType: 'scout', actorId: scoutId, action: 'scout_profile_updated', targetType: 'scout', targetId: scoutId });

    return res.json(scout);
  } catch (err) {
    console.error('[scout] updateMyContact error:', err.message);
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
}

async function getMySubscriptions(req, res) {
  try {
    const { data, error } = await supabase
      .from('scout_county_subscriptions')
      .select('*')
      .eq('scout_id', req.user.id)
      .order('county');
    if (error) throw error;

    const now = new Date();
    // Belt-and-suspenders: recompute status live off expires_at rather
    // than trusting whatever the 'status' column says, in case the
    // reminder cron job (Phase 4 step 4) hasn't run yet today - the
    // portal should never show a lapsed county as "active" just
    // because a scheduled job is hours away from marking it 'expired'.
    const rows = (data || []).map((r) => ({ ...r, status: new Date(r.expires_at) > now ? 'active' : 'expired' }));

    return res.json(rows);
  } catch (err) {
    console.error('[scout] getMySubscriptions error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch subscriptions.' });
  }
}

// ---------------------------------------------------------------------
// SCOUT: browse vacant (or, optionally, occupied) units in the
// counties the Scout currently has an ACTIVE (unexpired) subscription
// for. This is the missing "vacancy browser" referenced in the
// Phase 6 comment on the portal - a scout only sees units in counties
// they've actually paid for, and by default only sees vacant ones
// (the whole point of the product), with an explicit toggle to also
// see occupied units so a scout can track when a unit they placed
// someone in (or was watching) changes status.
//
// A unit's location is resolved from its property (if it belongs to
// one) - county/constituency/location(area) - falling back to the
// owning landlord's own county/constituency/location if the unit is
// ungrouped (property_id null), since that's still meaningful
// "where is this" info a landlord filled in during setup. Contact
// details prefer the property's caretaker (if the landlord set one
// up for that property), falling back to the landlord themself.
// ---------------------------------------------------------------------
async function getVacancies(req, res) {
  try {
    const scoutId = req.user.id;
    const statusFilter = req.query.status === 'all' ? 'all' : (req.query.status === 'occupied' ? 'occupied' : 'vacant');

    const now = new Date().toISOString();
    const { data: subs, error: subsErr } = await supabase
      .from('scout_county_subscriptions')
      .select('county, expires_at')
      .eq('scout_id', scoutId);
    if (subsErr) throw subsErr;

    const activeCounties = new Set((subs || []).filter((s) => s.expires_at > now).map((s) => s.county));
    if (activeCounties.size === 0) {
      return res.json({ activeCounties: [], units: [] });
    }

    // FIX (visibility bug found during the scout-role audit): a
    // landlord who has blocked this specific scout, or who has opted
    // out of scout visibility entirely (scout_visibility_enabled =
    // false), must never have their units, location, or contact info
    // surfaced here - this was previously not checked at all, so a
    // block/opt-out had zero actual effect. Both checks run up front
    // and produce a single exclusion set of landlord_ids, applied
    // when filtering units below (units.landlord_id if ungrouped, or
    // properties.landlord_id if the unit belongs to a property).
    const [{ data: blocks, error: blocksErr }, { data: optedOutLandlords, error: optOutErr }] = await Promise.all([
      supabase.from('blocked_scouts').select('landlord_id').eq('scout_id', scoutId),
      supabase.from('landlords').select('id').eq('scout_visibility_enabled', false),
    ]);
    if (blocksErr) throw blocksErr;
    if (optOutErr) throw optOutErr;

    const excludedLandlordIds = new Set([
      ...(blocks || []).map((b) => b.landlord_id),
      ...(optedOutLandlords || []).map((l) => l.id),
    ]);

    // PERF FIX ("Browse Vacancies takes forever to load"): this used
    // to select() every unit on the WHOLE platform (every landlord,
    // every county, no .limit()) with two joined tables, then throw
    // almost all of it away in JS via the .filter(activeCounties.has)
    // below. That's a full-table scan + join on every request, and it
    // gets slower every time a new unit is added anywhere on RentaPay
    // - completely independent of how few counties this scout
    // actually subscribed to. Now the county filter is pushed down
    // into the query itself (two queries, since a unit's county comes
    // from either its property or, if ungrouped, its landlord), so
    // Postgres only ever touches rows in counties this scout can see,
    // and each query is capped so one scout can't pull an unbounded
    // result set.
    const countyList = [...activeCounties];

    let propertyUnitsQuery = supabase
      .from('units')
      .select('id, unit_name, unit_type, rent_amount, status, updated_at, last_verified_at, landlord_id, photo_urls, ' +
        'properties!inner(name, county, constituency, location, caretaker_name, caretaker_phone, landlord_id), ' +
        'landlords(full_name, phone, county, constituency, location)')
      .in('properties.county', countyList)
      .order('updated_at', { ascending: false })
      .limit(500);
    if (statusFilter !== 'all') propertyUnitsQuery = propertyUnitsQuery.eq('status', statusFilter);

    let landlordUnitsQuery = supabase
      .from('units')
      .select('id, unit_name, unit_type, rent_amount, status, updated_at, last_verified_at, landlord_id, photo_urls, ' +
        'properties(name, county, constituency, location, caretaker_name, caretaker_phone, landlord_id), ' +
        'landlords!inner(full_name, phone, county, constituency, location)')
      .is('property_id', null)
      .in('landlords.county', countyList)
      .order('updated_at', { ascending: false })
      .limit(500);
    if (statusFilter !== 'all') landlordUnitsQuery = landlordUnitsQuery.eq('status', statusFilter);

    const [{ data: propertyUnits, error: puErr }, { data: landlordUnits, error: luErr }] = await Promise.all([
      propertyUnitsQuery,
      landlordUnitsQuery,
    ]);
    if (puErr) throw puErr;
    if (luErr) throw luErr;

    const units = [...(propertyUnits || []), ...(landlordUnits || [])];

    const resolved = (units || [])
      .map((u) => {
        const county = u.properties?.county || u.landlords?.county || null;
        const constituency = u.properties?.constituency || u.landlords?.constituency || null;
        const area = u.properties?.location || u.landlords?.location || null;
        const contactName = u.properties?.caretaker_name || u.landlords?.full_name || null;
        const contactPhone = u.properties?.caretaker_phone || u.landlords?.phone || null;
        const landlordId = u.properties?.landlord_id || u.landlord_id || null;
        return {
          id: u.id,
          unitName: u.unit_name,
          unitType: u.unit_type,
          rentAmount: u.rent_amount,
          status: u.status,
          updatedAt: u.updated_at,
          lastVerifiedAt: u.last_verified_at,
          propertyName: u.properties?.name || null,
          photoUrls: Array.isArray(u.photo_urls) ? u.photo_urls : [],
          county,
          constituency,
          area,
          contactName,
          contactPhone,
          landlordId,
        };
      })
      .filter((u) => u.county && activeCounties.has(u.county))
      .filter((u) => !u.landlordId || !excludedLandlordIds.has(u.landlordId));

    return res.json({ activeCounties: [...activeCounties], units: resolved });
  } catch (err) {
    console.error('[scout] getVacancies error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch vacancies.' });
  }
}

// ---------------------------------------------------------------------
// SCOUT REFERRAL TRACKING (spec: "Scout Referral Tracking &
// Notifications") - a scout taps "Share this unit" on a vacancy card,
// this logs a scout_referrals row and notifies the landlord/manager/
// caretaker by SMS + in-app inbox + live push. Deliberately does NOT
// re-check county subscription/block/opt-out here the way getVacancies
// does - if a scout can see this unitId at all (i.e. they loaded it
// from their own vacancy list a moment ago), sharing it is always
// allowed; those checks exist to gate WHAT a scout can browse, not to
// re-litigate every action taken on something they already legitimately saw.
// ---------------------------------------------------------------------
async function referUnit(req, res) {
  try {
    const scoutId = req.user.id;
    const { unitId } = req.body;
    if (!unitId) return res.status(400).json({ error: 'unitId is required.' });

    const { data: unit, error: unitErr } = await supabase
      .from('units')
      .select('id, unit_name, status, landlord_id, property_id')
      .eq('id', unitId)
      .maybeSingle();
    if (unitErr) throw unitErr;
    if (!unit) return res.status(404).json({ error: 'Unit not found.' });

    const { data: scout, error: scoutErr } = await supabase
      .from('scouts')
      .select('full_name')
      .eq('id', scoutId)
      .maybeSingle();
    if (scoutErr) throw scoutErr;

    // Log the referral event regardless of the cooldown below - the
    // cooldown only skips the repeat NOTIFICATION, not the pipeline
    // record itself, so the scout's own stats/history never silently
    // drop a share just because they shared the same unit twice in a day.
    const { data: referral, error } = await supabase
      .from('scout_referrals')
      .insert({ scout_id: scoutId, unit_id: unitId, landlord_id: unit.landlord_id, status: 'shared' })
      .select()
      .single();
    if (error) throw error;

    // "Already notified recently" means a PRIOR referral (not the one
    // we just inserted above) from this scout for this unit within the
    // cooldown window.
    const { data: priorReferral } = await supabase
      .from('scout_referrals')
      .select('id')
      .eq('scout_id', scoutId)
      .eq('unit_id', unitId)
      .neq('id', referral.id)
      .gt('shared_at', new Date(Date.now() - scoutReferralService.RENOTIFY_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle();

    if (!priorReferral) {
      await scoutReferralService.notifyReferralCreated({
        unit,
        scoutName: scout?.full_name || 'A scout',
        unitName: unit.unit_name,
      });
    }

    logActivity({ actorType: 'scout', actorId: scoutId, action: 'unit_referred', targetType: 'unit', targetId: unitId });

    return res.status(201).json({
      message: 'Referral logged. The landlord has been notified.',
      referral: { id: referral.id, status: referral.status, sharedAt: referral.shared_at },
    });
  } catch (err) {
    console.error('[scout] referUnit error:', err.message);
    return res.status(500).json({ error: 'Failed to log referral.' });
  }
}

// ---------------------------------------------------------------------
// SCOUT: "X units shared this month / X landlord views / X confirmed
// placements" plus the underlying list, for ScoutStatsPanel.jsx.
// ---------------------------------------------------------------------
async function getMyReferrals(req, res) {
  try {
    const scoutId = req.user.id;

    const { data, error } = await supabase
      .from('scout_referrals')
      .select('id, status, shared_at, viewed_at, placed_at, payout_status, payout_amount, payout_paid_at, units(unit_name)')
      .eq('scout_id', scoutId)
      .order('shared_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    const rows = data || [];
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const sharedThisMonth = rows.filter((r) => new Date(r.shared_at) >= startOfMonth).length;
    const landlordViews = rows.filter((r) => r.viewed_at).length;
    const placements = rows.filter((r) => r.status === 'placed').length;
    // FEATURE (scout referral payout tracking): lets a scout see at a
    // glance what's owed vs. already paid, instead of the platform
    // going silent the moment a placement is credited.
    const totalOwed = rows.filter((r) => r.payout_status === 'pending').reduce((sum, r) => sum + Number(r.payout_amount || 0), 0);
    const totalPaid = rows.filter((r) => r.payout_status === 'paid').reduce((sum, r) => sum + Number(r.payout_amount || 0), 0);

    return res.json({
      stats: { sharedThisMonth, landlordViews, placements, totalOwed, totalPaid },
      referrals: rows.map((r) => ({
        id: r.id,
        unitName: r.units?.unit_name || null,
        status: r.status,
        sharedAt: r.shared_at,
        viewedAt: r.viewed_at,
        placedAt: r.placed_at,
        payoutStatus: r.payout_status,
        payoutAmount: r.payout_amount,
        payoutPaidAt: r.payout_paid_at,
      })),
    });
  } catch (err) {
    console.error('[scout] getMyReferrals error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch referrals.' });
  }
}

// ---------------------------------------------------------------------
// LANDLORD/MANAGER/CARETAKER: the small UI hook that marks a referral
// "viewed" - called once by the frontend the first time the "Scout
// referral" badge actually renders for them (not on every page load of
// the same badge). Deliberately 404s rather than hard-403ing on a
// referral that isn't this landlord's - a wrong/stale referralId here
// is far more likely to be a UI race (e.g. the referral got
// auto-credited to 'placed' a moment earlier) than a genuine
// cross-account access attempt, and the ownership check below still
// runs either way.
// ---------------------------------------------------------------------
async function markReferralViewed(req, res) {
  try {
    const { referralId } = req.params;
    const { data: referral } = await supabase.from('scout_referrals').select('id, landlord_id').eq('id', referralId).maybeSingle();
    if (!referral) return res.status(404).json({ error: 'Referral not found.' });

    const ownershipError = await checkLandlordOwnership(req, referral.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);

    await scoutReferralService.markReferralViewed(referralId);
    return res.json({ message: 'Marked as viewed.' });
  } catch (err) {
    console.error('[scout] markReferralViewed error:', err.message);
    return res.status(500).json({ error: 'Failed to update referral.' });
  }
}

// ---------------------------------------------------------------------
// LANDLORD: block/unblock a specific scout from seeing this landlord's
// units, and view the current block list. A scout is identified by
// scoutId - in practice the landlord gets this from a scout_landlord
// chat thread ("Block this scout" action), since a landlord has no
// other way to look a scout up by name/phone.
// ---------------------------------------------------------------------
async function listBlockedScouts(req, res) {
  try {
    const landlordId = req.user.id;
    const { data, error } = await supabase
      .from('blocked_scouts')
      .select('scout_id, blocked_at, scouts(full_name, phone)')
      .eq('landlord_id', landlordId)
      .order('blocked_at', { ascending: false });
    if (error) throw error;

    const blocked = (data || []).map((b) => ({
      scoutId: b.scout_id,
      blockedAt: b.blocked_at,
      fullName: b.scouts?.full_name || null,
      phone: b.scouts?.phone || null,
    }));
    return res.json({ blocked });
  } catch (err) {
    console.error('[scout] listBlockedScouts error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch blocked scouts.' });
  }
}

async function blockScout(req, res) {
  try {
    const landlordId = req.user.id;
    const { scoutId } = req.body;
    if (!scoutId) return res.status(400).json({ error: 'scoutId is required.' });

    const { data: scout } = await supabase.from('scouts').select('id').eq('id', scoutId).maybeSingle();
    if (!scout) return res.status(404).json({ error: 'Scout not found.' });

    const { error } = await supabase
      .from('blocked_scouts')
      .upsert({ landlord_id: landlordId, scout_id: scoutId }, { onConflict: 'landlord_id,scout_id' });
    if (error) throw error;

    logActivity({ actorType: 'landlord', actorId: landlordId, action: 'scout_blocked', targetType: 'scout', targetId: scoutId });

    return res.json({ message: 'Scout blocked. They will no longer see your units or be able to message you.' });
  } catch (err) {
    console.error('[scout] blockScout error:', err.message);
    return res.status(500).json({ error: 'Failed to block scout.' });
  }
}

async function unblockScout(req, res) {
  try {
    const landlordId = req.user.id;
    const { scoutId } = req.body;
    if (!scoutId) return res.status(400).json({ error: 'scoutId is required.' });

    const { error } = await supabase.from('blocked_scouts').delete().eq('landlord_id', landlordId).eq('scout_id', scoutId);
    if (error) throw error;

    logActivity({ actorType: 'landlord', actorId: landlordId, action: 'scout_unblocked', targetType: 'scout', targetId: scoutId });

    return res.json({ message: 'Scout unblocked.' });
  } catch (err) {
    console.error('[scout] unblockScout error:', err.message);
    return res.status(500).json({ error: 'Failed to unblock scout.' });
  }
}

// ---------------------------------------------------------------------
// LANDLORD: read/toggle scout_visibility_enabled (opt out of the whole
// scout marketplace entirely, rather than blocking one at a time), and
// track that they've seen the one-time disclosure explaining what
// this means (schema already has scout_disclosure_seen_at from Phase 1).
// ---------------------------------------------------------------------
async function getScoutVisibilitySettings(req, res) {
  try {
    const landlordId = req.user.id;
    const { data, error } = await supabase
      .from('landlords')
      .select('scout_visibility_enabled, scout_disclosure_seen_at')
      .eq('id', landlordId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Account not found.' });

    return res.json({
      scoutVisibilityEnabled: data.scout_visibility_enabled,
      scoutDisclosureSeenAt: data.scout_disclosure_seen_at,
    });
  } catch (err) {
    console.error('[scout] getScoutVisibilitySettings error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch settings.' });
  }
}

async function setScoutVisibility(req, res) {
  try {
    const landlordId = req.user.id;
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });

    const updates = { scout_visibility_enabled: enabled };
    // First time this landlord touches the toggle at all, also record
    // that they've seen the disclosure - same one-time-seen pattern
    // as other disclosure/acknowledgement flags in this codebase.
    const { data: current } = await supabase.from('landlords').select('scout_disclosure_seen_at').eq('id', landlordId).maybeSingle();
    if (current && !current.scout_disclosure_seen_at) {
      updates.scout_disclosure_seen_at = new Date().toISOString();
    }

    const { error } = await supabase.from('landlords').update(updates).eq('id', landlordId);
    if (error) throw error;

    logActivity({ actorType: 'landlord', actorId: landlordId, action: enabled ? 'scout_visibility_enabled' : 'scout_visibility_disabled', targetType: 'landlord', targetId: landlordId });

    return res.json({ message: enabled ? 'Scouts can now see your vacant units.' : 'Your units are now hidden from all scouts.' });
  } catch (err) {
    console.error('[scout] setScoutVisibility error:', err.message);
    return res.status(500).json({ error: 'Failed to update setting.' });
  }
}

// ---------------------------------------------------------------------
// PUSH TRIGGER (Pass 2, item 3): called from unit.controller.js's
// updateUnitStatus whenever a unit's status flips to 'vacant'. Reuses
// the exact same county-resolution and visibility-exclusion rules as
// getVacancies above (property county, falling back to the landlord's
// own county; skip if the landlord has opted out of scout visibility
// entirely or has blocked a given scout) so a scout is never pushed a
// vacancy they wouldn't actually be allowed to see in the vacancy
// browser itself. Never throws - same "never blocks the real action"
// convention as every other notify/push call site in this codebase.
// ---------------------------------------------------------------------
async function notifyScoutsOfNewVacancy({ unitId, unitName, propertyId, landlordId }) {
  try {
    if (!landlordId) return;

    const [{ data: property }, { data: landlord }] = await Promise.all([
      propertyId ? supabase.from('properties').select('county').eq('id', propertyId).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from('landlords').select('county, scout_visibility_enabled').eq('id', landlordId).maybeSingle(),
    ]);

    if (landlord && landlord.scout_visibility_enabled === false) return; // landlord opted out entirely

    const county = property?.county || landlord?.county || null;
    if (!county) return;

    const now = new Date().toISOString();
    const [{ data: subs, error: subsErr }, { data: blocks, error: blocksErr }] = await Promise.all([
      supabase.from('scout_county_subscriptions').select('scout_id').eq('county', county).gt('expires_at', now),
      supabase.from('blocked_scouts').select('scout_id').eq('landlord_id', landlordId),
    ]);
    if (subsErr || blocksErr) throw subsErr || blocksErr;

    const blockedScoutIds = new Set((blocks || []).map((b) => b.scout_id));
    const eligibleScoutIds = [...new Set((subs || []).map((s) => s.scout_id))].filter((id) => !blockedScoutIds.has(id));
    if (eligibleScoutIds.length === 0) return;

    const payload = {
      title: 'New vacancy in ' + county,
      body: `${unitName || 'A unit'} just went vacant in ${county}. Check it out in the vacancy browser.`,
      url: '/scout',
    };

    await Promise.allSettled(eligibleScoutIds.map((scoutId) => sendPushToRecipient('scout', scoutId, payload)));
  } catch (err) {
    console.error('[scout] notifyScoutsOfNewVacancy error:', err.message);
  }
}

module.exports = {
  getCountyPricing,
  registerScout,
  subscribeCounties,
  processScoutCountyPaymentCallback,
  activateScoutCounties,
  submitManualCountyPayment,
  getMyLatestManualCountyPayment,
  getMyProfile,
  updateMyContact,
  listManualCountyPayments,
  confirmManualCountyPayment,
  rejectManualCountyPayment,
  deleteManualCountyPayment,
  getMySubscriptions,
  getVacancies,
  referUnit,
  getMyReferrals,
  markReferralViewed,
  listBlockedScouts,
  blockScout,
  unblockScout,
  getScoutVisibilitySettings,
  setScoutVisibility,
  // BUG FIX: this was defined above but missing from this export list.
  // unit.controller.js does `const { notifyScoutsOfNewVacancy } =
  // require('./scout.controller')`, which silently resolved to
  // `undefined` without this - so EVERY unit creation crashed with
  // "notifyScoutsOfNewVacancy is not a function" the moment it tried
  // to notify scouts of the new vacancy, taking the whole request down
  // with a 500 (visible as "Failed to create unit" / "Saved 0 of N
  // units" in the Add Units step of registration).
  notifyScoutsOfNewVacancy,
};
