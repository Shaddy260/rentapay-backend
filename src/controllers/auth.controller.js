// src/controllers/auth.controller.js
//
// Handles registration/login for landlords and tenants, matching the
// flows in blueprint 3.1 (Landlord Registration) and 4 (Tenant Onboarding).
// Note: tenant ACCOUNTS are created by landlords (see tenant.controller.js),
// this file just handles their login + OTP verification.

const supabase = require('../config/supabase');
const { hashPassword, comparePassword, validatePasswordStrength } = require('../utils/password');
const { generateOTP, getOTPExpiry, getPasswordResetOTPExpiry, isOTPExpired } = require('../utils/otp');
const { normalizePhone, normalizePhoneOrThrow } = require('../utils/phone');
const { isValidEmail } = require('../utils/email');
const { findPhoneConflict } = require('../utils/phoneUniqueness');
const { signToken, effectiveLandlordId } = require('../middleware/auth.middleware');
const { calculateSubscriptionCost } = require('../utils/pricing');
const { initiateSTKPush } = require('../services/daraja.service');
const { sendEmail, wrapEmailHtml, SUPPORT_EMAIL } = require('../services/email.service');
const templates = require('../services/notificationTemplates');
const { logActivity } = require('../services/activityLog.service');
const { postSystemAnnouncement, getActorDisplay } = require('./announcement.controller');
const { KENYA_COUNTIES } = require('../constants/kenyaCounties');
const { KENYA_CONSTITUENCIES } = require('../constants/kenyaConstituencies');

const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_MINUTES = 30;

// Maps an accountType to its table + the column that stores its phone
// number. Centralized here so adding the 'manager' (and now 'scout')
// account type only needed one place to change instead of five
// near-identical ternaries.
function accountTable(accountType) {
  if (accountType === 'landlord') return { table: 'landlords', phoneField: 'phone' };
  if (accountType === 'manager') return { table: 'property_managers', phoneField: 'phone' };
  if (accountType === 'scout') return { table: 'scouts', phoneField: 'phone' };
  return { table: 'tenants', phoneField: 'primary_phone' };
}

const ALL_ACCOUNT_TYPES = ['landlord', 'manager', 'tenant', 'scout'];

// LOGIN UNIFICATION: checks a phone number against every account type
// in one round-trip (fired in parallel, not sequentially - same
// perf reasoning as the lockdown-check-in-parallel fix below). Returns
// an array of matches - normally 0 or 1, occasionally 2+ (the
// dual-role case, e.g. a landlord who also has a separate property
// manager login). Scout accounts are now exclusive (phoneUniqueness.js
// rejects a Scout registration on a phone already used elsewhere, and
// vice versa), so a fresh signup can no longer produce a landlord+Scout
// dual match here - this picker only still matters for the
// landlord/manager/tenant combinations that were always allowed to
// coexist, plus any pre-existing dual accounts from before that change.
// Each match: { accountType, account }.
async function findAccountsByPhone(phone) {
  const results = await Promise.all(
    ALL_ACCOUNT_TYPES.map((accountType) => {
      const { table, phoneField } = accountTable(accountType);
      return supabase.from(table).select('*').eq(phoneField, phone).maybeSingle();
    })
  );
  return ALL_ACCOUNT_TYPES
    .map((accountType, i) => ({ accountType, account: results[i].data }))
    .filter((r) => r.account && !results[ALL_ACCOUNT_TYPES.indexOf(r.accountType)].error);
}

// EMAIL LOGIN / PASSWORD RESET: same cross-role lookup as
// findAccountsByPhone above, but keyed on the account's registered
// email address instead of its phone number. Email is mandatory on
// every account type now, so this is always usable - unlike phone,
// it never needs a "no email on file" fallback. Matching is done
// case-insensitively (ilike) since emails are conventionally
// case-insensitive and a person retyping their address later may not
// match the exact casing it was originally stored in.
async function findAccountsByEmail(email) {
  const results = await Promise.all(
    ALL_ACCOUNT_TYPES.map((accountType) => {
      const { table } = accountTable(accountType);
      return supabase.from(table).select('*').ilike('email', email).maybeSingle();
    })
  );
  return ALL_ACCOUNT_TYPES
    .map((accountType, i) => ({ accountType, account: results[i].data }))
    .filter((r) => r.account && !results[ALL_ACCOUNT_TYPES.indexOf(r.accountType)].error);
}

// Human label for the account picker shown on a dual-role login (Phase
// 2b/step 5). Kept out of the frontend so the backend - which already
// knows role_level for managers - is the single source of truth for
// how an account should be described.
function accountTypeLabel(accountType, account) {
  if (accountType === 'manager') return account.role_level === 'caretaker' ? 'Caretaker' : 'Property Manager';
  if (accountType === 'landlord') return 'Landlord';
  if (accountType === 'scout') return 'RentaPay Scout';
  return 'Tenant';
}

// ---------------------------------------------------------------------
// LANDLORD REGISTRATION (blueprint 3.1)
// Step 1: collect details + chosen plan, trigger STK push for subscription
// ---------------------------------------------------------------------
async function registerLandlord(req, res) {
  let insertedLandlordId = null; // tracked so we can roll back on failure

  try {
    let { fullName, phone, email, password, gender, unitsCount, periodMonths } = req.body;

    // DIRECT REQUEST: email is now mandatory during setup - it's the
    // only channel OTPs, password resets, and every other account
    // notification go out on now that WhatsApp is disabled (see
    // notify.service.js / sms.service.js). Phone is still collected
    // and used for login + M-Pesa STK, but email is where messages land.
    if (!fullName || !phone || !email || !password || !unitsCount || !periodMonths) {
      return res.status(400).json({ error: 'fullName, phone, email, password, unitsCount, and periodMonths are required.' });
    }
    email = email.trim();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // Optional - direct request to ask gender during setup so the
    // portal can address a landlady correctly from day one instead of
    // defaulting everyone to "Landlord". Never blocks signup if left
    // unanswered.
    if (gender !== undefined && gender !== null && gender !== '' && !['male', 'female'].includes(gender)) {
      return res.status(400).json({ error: "gender must be 'male' or 'female'." });
    }

    // THE FIX for "no matching account found" / duplicate-account bugs:
    // normalize to one canonical shape (2547XXXXXXXX) before this number
    // ever touches the database, so every later lookup (login,
    // resend-otp, forgot-password) - which also normalizes first - is
    // guaranteed to match regardless of how the person typed it here.
    try {
      phone = normalizePhoneOrThrow(phone, 'Phone number');
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    const { isValid, errors } = validatePasswordStrength(password, { phone, name: fullName });
    if (!isValid) {
      return res.status(400).json({ error: 'Weak password.', details: errors });
    }

    const { data: existing } = await supabase.from('landlords').select('id, subscription_status').eq('phone', phone).maybeSingle();

    if (existing) {
      // Only block on a genuinely active/verified account. A 'pending'
      // record means a PREVIOUS registration attempt got this far and
      // then failed before payment completed (e.g. the exact orphan-
      // record bug this fix addresses) - we delete the stale attempt
      // and let this request proceed, rather than permanently locking
      // the phone number out.
      if (existing.subscription_status === 'pending') {
        await supabase.from('landlords').delete().eq('id', existing.id);
        console.warn(`[auth] Removed stale pending registration for phone ${phone} (id ${existing.id}) to allow retry.`);
      } else {
        return res.status(409).json({ error: 'An account with this phone number already exists.' });
      }
    }

    // "No number should open more than one user account" - also reject
    // if this phone is already a manager/caretaker or an active tenant
    // account elsewhere (see phoneUniqueness.js for the exact rules,
    // including the archived-tenant exception).
    const conflict = await findPhoneConflict(phone, 'landlord');
    if (conflict) return res.status(409).json({ error: conflict });

    // FIX (direct request: "when a user enters an email that has
    // already been used it does not give an error but silently
    // refuses and does not proceed to the next step"): landlords.email
    // has a database-level unique constraint, so a duplicate email
    // WAS always being rejected - just as a raw Postgres constraint-
    // violation string surfacing through the generic catch-all below,
    // which read like no error at all by the time it reached the
    // frontend (see RegisterFlow.jsx's handleSubmitDetails fix). Check
    // explicitly first so this gets the same clean, specific message
    // as every other conflict check above.
    if (email) {
      const { data: existingEmail } = await supabase.from('landlords').select('id').eq('email', email).maybeSingle();
      if (existingEmail) return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const { totalCost } = calculateSubscriptionCost(Number(unitsCount), Number(periodMonths));
    const passwordHash = await hashPassword(password);

    const { data: landlord, error } = await supabase
      .from('landlords')
      .insert({
        full_name: fullName,
        phone,
        email: email || null,
        gender: gender || null,
        password_hash: passwordHash,
        subscription_period_months: periodMonths,
        unit_limit: unitsCount,
        subscription_status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
    insertedLandlordId = landlord.id;

    // Trigger STK push for the subscription payment (blueprint 3.1).
    // If this throws - wrong/missing Daraja credentials, sandbox
    // unreachable, invalid callback URL - we roll back the insert
    // above instead of leaving an orphan 'pending' row behind. This is
    // the fix for the "Account already exists" loop: previously a
    // failed STK push left the row in place permanently.
    let stkResponse;
    try {
      stkResponse = await initiateSTKPush({
        phoneNumber: phone,
        amount: totalCost,
        accountReference: `RENTAPAY-${landlord.id.slice(0, 8)}`,
        transactionDesc: 'RentaPay subscription',
      });
    } catch (stkErr) {
      await supabase.from('landlords').delete().eq('id', landlord.id);
      console.error('[auth] STK push failed, rolled back landlord insert:', stkErr.message);
      return res.status(502).json({
        error: 'Could not initiate M-Pesa payment. Your registration was not saved - please try again.',
        details: stkErr.message,
      });
    }

    // ----- THE MISSING PIECE -----
    // Without this insert, the Daraja callback (handleSTKCallback in
    // payment.controller.js) has nothing to match the incoming
    // CheckoutRequestID against - it looks up `subscription_payments`
    // by mpesa_checkout_request_id, finds no row, and silently no-ops.
    // That means even a SUCCESSFUL real payment would never activate
    // the account. This was happening regardless of the orphan-record
    // bug above; both needed fixing.
    //
    // `plan` derivation: the blueprint's final per-unit pricing model
    // (150/unit/month with period discounts) doesn't actually gate
    // anything by a named tier, but subscription_payments.plan is
    // NOT NULL with a starter/standard/premium check constraint. This
    // bucket-by-unit-count assumption matches the tier boundaries from
    // the original plan-based pricing draft - revisit if you want
    // different boundaries, since nothing else in the current pricing
    // logic depends on this value.
    const plan = unitsCount <= 10 ? 'starter' : unitsCount <= 50 ? 'standard' : 'premium';

    const { error: subPaymentError } = await supabase.from('subscription_payments').insert({
      landlord_id: landlord.id,
      plan,
      period_months: periodMonths,
      units_count: unitsCount,
      amount: totalCost,
      mpesa_checkout_request_id: stkResponse.CheckoutRequestID,
      status: 'pending',
    });

    if (subPaymentError) {
      // We already charged the M-Pesa prompt at this point (STK push
      // succeeded) - rolling back the landlord row here would let the
      // person pay with no account to show for it. Log loudly instead
      // so this is investigated, but don't roll back.
      console.error(
        '[auth] CRITICAL: STK push succeeded but failed to record subscription_payments row:',
        subPaymentError.message,
        '- checkoutRequestId:', stkResponse.CheckoutRequestID,
        '- landlordId:', landlord.id
      );
    }

    logActivity({
      actorType: 'system',
      action: 'landlord_registration_initiated',
      targetType: 'landlord',
      targetId: landlord.id,
      metadata: { totalCost, unitsCount, periodMonths },
    });

    return res.status(201).json({
      message: 'Registration started. Complete the M-Pesa prompt sent to your phone to activate your account.',
      landlordId: landlord.id,
      amountDue: totalCost,
      checkoutRequestId: stkResponse.CheckoutRequestID,
    });
  } catch (err) {
    // Belt-and-suspenders: if something else entirely throws after the
    // insert succeeded (e.g. logActivity throwing - it shouldn't, see
    // activityLog.service.js, but just in case), still clean up rather
    // than leave an orphan.
    if (insertedLandlordId) {
      await supabase.from('landlords').delete().eq('id', insertedLandlordId).then(
        () => console.warn(`[auth] Rolled back orphaned landlord ${insertedLandlordId} after unexpected error.`),
        () => {}
      );
    }
    console.error('[auth] registerLandlord error:', err.message);
    return res.status(500).json({ error: 'Failed to register landlord.', details: err.message });
  }
}

/**
 * Called internally once the subscription payment is confirmed - either
 * by Daraja's callback (payment.controller.js handleSubscriptionCallback)
 * or by an admin manually approving a submitted payment
 * (landlordManualSubscriptionPayment.controller.js). This IS the
 * account's verification step now.
 *
 * DIRECT REQUEST FIX ("OTP should not have authority to confirm/verify
 * the account - what confirms it should be the payment"): this used to
 * generate an OTP here and leave is_verified false until the landlord
 * separately typed that code in. That made the OTP the real gate, not
 * the payment - a payment could be confirmed and the account would
 * still sit unverified/unusable until an unrelated SMS round-trip
 * happened too. Payment confirmation (whichever path confirmed it) now
 * verifies the account directly - no OTP generated, none sent.
 *
 * DIRECT REQUEST FIX ("subscription counter is normally null until I
 * go adjust it in Supabase myself"): this used to only flip
 * subscription_status to 'active' and stamp subscription_started_at,
 * but never set subscription_expires_at - that only ever got set later
 * by a RENEWAL (see the `else` branches in payment.controller.js's
 * handleSubscriptionCallback and landlordManualSubscriptionPayment
 * .controller.js's confirmManualSubscriptionPayment). A brand-new
 * landlord's very first activation fell through neither of those, so
 * the expiry column - and with it every "days left"/countdown display
 * that reads it - stayed null indefinitely. periodMonths is passed in
 * by both callers (each already knows exactly what was paid for from
 * their own payment record); if a future caller doesn't have it handy,
 * this falls back to the landlord's own subscription_period_months
 * (already set at signup) rather than leaving the expiry unset.
 */
async function activateLandlordAfterPayment(landlordId, periodMonths) {
  let months = Number(periodMonths);
  if (!months || months < 1) {
    const { data: existing } = await supabase.from('landlords').select('subscription_period_months').eq('id', landlordId).maybeSingle();
    months = existing?.subscription_period_months || 1;
  }

  const startedAt = new Date();
  const expiresAt = new Date(startedAt);
  expiresAt.setMonth(expiresAt.getMonth() + months);

  const { data: landlord, error } = await supabase
    .from('landlords')
    .update({
      is_verified: true,
      otp_code: null,
      otp_expires_at: null,
      subscription_status: 'active',
      subscription_started_at: startedAt.toISOString(),
      subscription_expires_at: expiresAt.toISOString(),
      subscription_period_months: months,
    })
    .eq('id', landlordId)
    .select()
    .single();

  if (error) throw error;

  return landlord;
}

// ---------------------------------------------------------------------
// OTP VERIFICATION (shared shape for landlord/tenant)
// ---------------------------------------------------------------------
async function verifyOTP(req, res) {
  try {
    const { accountType, accountId, otp } = req.body; // accountType: 'landlord' | 'tenant' | 'manager' | 'scout'

    if (!ALL_ACCOUNT_TYPES.includes(accountType)) {
      return res.status(400).json({ error: "accountType must be 'landlord', 'tenant', 'manager', or 'scout'." });
    }

    // DIRECT REQUEST FIX: landlord accounts are verified solely by
    // payment confirmation now (see activateLandlordAfterPayment) -
    // there is no OTP code for a landlord to ever enter here. Reject
    // explicitly instead of falling through to a confusing "Invalid
    // OTP" (resendOTP no longer issues landlord codes either, so
    // otp_code would just never match).
    if (accountType === 'landlord') {
      return res.status(400).json({ error: 'Landlord accounts are verified automatically once your subscription payment is confirmed - there is no code to enter.' });
    }

    const { table } = accountTable(accountType);
    const { data: account, error } = await supabase.from(table).select('*').eq('id', accountId).maybeSingle();

    if (error || !account) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    if (!account.otp_code || account.otp_code !== otp) {
      return res.status(400).json({ error: 'Invalid OTP.' });
    }

    if (isOTPExpired(account.otp_expires_at)) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    const updateFields = { is_verified: true, otp_code: null, otp_expires_at: null };
    const { error: updateError } = await supabase.from(table).update(updateFields).eq('id', accountId);

    if (updateError) throw updateError;

    return res.json({ message: 'Account verified successfully.' });
  } catch (err) {
    console.error('[auth] verifyOTP error:', err.message);
    return res.status(500).json({ error: 'Failed to verify OTP.' });
  }
}

// ---------------------------------------------------------------------
// LOGIN (landlord or tenant) — shared logic, with lockout per blueprint 14.2
// ---------------------------------------------------------------------
async function login(req, res) {
  try {
    const { password } = req.body;
    let { phone, email, accountType } = req.body;

    // LOGIN VIA EMAIL OR PHONE: since every account now has a
    // mandatory email address, a person can sign in with either their
    // phone number or their registered email - whichever they find
    // easier to remember. Exactly one identifier is expected; if both
    // happen to be sent, phone wins (keeps old callers - which only
    // ever sent phone - behaving exactly as before).
    const usingEmail = !phone && !!email;

    if (!phone && !email) {
      return res.status(400).json({ error: 'phone (or email) and password are required.' });
    }
    if (!password) {
      return res.status(400).json({ error: 'phone (or email) and password are required.' });
    }

    // accountType is now OPTIONAL. LOGIN UNIFICATION (was: explicit
    // Landlord/Property Manager/Caretaker/Tenant tabs on the frontend,
    // each sending a fixed accountType). It's only ever sent by the
    // client in ONE situation now: re-submitting login after the
    // dual-role account picker below, to say which of the matched
    // accounts to actually log into. A caller that still sends it
    // up-front (nothing currently does, but nothing breaks either) is
    // simply routed straight to that account type, same as before.
    if (accountType && !ALL_ACCOUNT_TYPES.includes(accountType)) {
      return res.status(400).json({ error: "accountType, if provided, must be 'landlord', 'manager', 'tenant', or 'scout'." });
    }

    // Same normalization as registration - without this, a tenant/
    // landlord typing their number in a different (but equivalent)
    // format than however it happened to be stored would get a false
    // "Invalid phone number or password" on every attempt.
    if (!usingEmail) {
      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone) phone = normalizedPhone;
    }

    // Generic invalid-credentials message - identical whether the
    // person signed in with phone or email, so neither reveals which
    // identifier (if either) is actually registered.
    const invalidCredsMsg = usingEmail ? 'Invalid email or password.' : 'Invalid phone number or password.';

    // PERFORMANCE FIX (direct request: "takes too long to log in"):
    // the lockdown check doesn't depend on the account lookup(s) below
    // at all - fire it in parallel rather than sequentially, same as
    // before this rewrite.
    const settingsPromise = supabase.from('platform_settings').select('is_locked_down, lockdown_reason').eq('id', 1).maybeSingle();

    let table, phoneField, account;

    if (accountType) {
      // Disambiguation re-submit (or an explicit legacy call) - go
      // straight to that one account type/table, exactly like the
      // pre-unification code did.
      ({ table, phoneField } = accountTable(accountType));
      const lookupPromise = usingEmail
        ? supabase.from(table).select('*').ilike('email', email).maybeSingle()
        : supabase.from(table).select('*').eq(phoneField, phone).maybeSingle();
      const [{ data: settings }, { data: acc, error }] = await Promise.all([settingsPromise, lookupPromise]);
      if (settings?.is_locked_down) {
        return res.status(503).json({ error: settings.lockdown_reason || 'The platform is temporarily paused for technical maintenance.', lockedDown: true });
      }
      if (error || !acc) {
        return res.status(401).json({ error: invalidCredsMsg });
      }
      account = acc;
      if (usingEmail) phone = acc[phoneField];
    } else {
      // No accountType supplied - auto-detect by checking every
      // account table for this phone number (or email) in one
      // round-trip.
      const [{ data: settings }, matches] = await Promise.all([
        settingsPromise,
        usingEmail ? findAccountsByEmail(email) : findAccountsByPhone(phone),
      ]);
      if (settings?.is_locked_down) {
        return res.status(503).json({ error: settings.lockdown_reason || 'The platform is temporarily paused for technical maintenance.', lockedDown: true });
      }

      if (matches.length === 0) {
        // Never reveal whether the phone/email exists at all -
        // identical response to a wrong password on a real account.
        return res.status(401).json({ error: invalidCredsMsg });
      }

      if (matches.length === 1) {
        accountType = matches[0].accountType;
        account = matches[0].account;
        ({ table, phoneField } = accountTable(accountType));
        if (usingEmail) phone = account[phoneField];
      } else {
        // Dual-role case (e.g. a landlord who is also a Scout on the
        // side): check the password against every matched account,
        // and only ever mention the ones it actually unlocks - a
        // person who only knows one of the two passwords should never
        // learn that a second account on this number exists at all.
        const checks = await Promise.all(
          matches.map(async (m) => ({ ...m, ok: await comparePassword(password, m.account.password_hash) }))
        );
        const unlocked = checks.filter((c) => c.ok);

        if (unlocked.length === 0) {
          return res.status(401).json({ error: invalidCredsMsg });
        }

        if (unlocked.length > 1) {
          // Genuinely ambiguous: this password is correct on two or
          // more account types for this number. Let the person choose
          // - the frontend re-submits login with accountType attached,
          // landing on the `if (accountType)` branch above.
          return res.status(200).json({
            needsAccountPicker: true,
            options: unlocked.map((u) => ({ accountType: u.accountType, id: u.account.id, label: accountTypeLabel(u.accountType, u.account) })),
          });
        }

        // Exactly one of the matched accounts has this password - no
        // real ambiguity, so proceed straight into it rather than
        // showing a picker with a single button. The password has
        // already been confirmed correct, but the shared logic below
        // (lockout counters, suspension checks, etc.) still needs to
        // run for this specific account, so it re-checks it - a single
        // extra bcrypt.compare() is a small, worthwhile price for not
        // duplicating all of that logic here.
        accountType = unlocked[0].accountType;
        account = unlocked[0].account;
        ({ table, phoneField } = accountTable(accountType));
        if (usingEmail) phone = account[phoneField];
      }
    }

    if (account.locked_until && new Date(account.locked_until) > new Date()) {
      return res.status(423).json({ error: `Account locked due to repeated failed attempts. Try again after ${account.locked_until}.` });
    }

    // THE FIX for "I suspended a landlord in the admin portal but they
    // logged in just fine": setLandlordStatus() (admin.controller.js)
    // was correctly writing subscription_status = 'suspended' to the
    // database the whole time - login() just never read that field to
    // decide anything. Checked before password verification (same
    // place as the account-lock check above) so a suspended landlord
    // is turned away regardless of whether they still know their
    // password.
    //
    // NOTE: 'suspended' now means ONLY "an admin deliberately banned
    // this account" - a lapsed subscription writes 'expired' instead
    // (see subscriptionReminders.job.js), which is intentionally NOT
    // checked here. An expired landlord should still be able to log
    // in and see their dashboard; they just get subscriptionExpired:
    // true in the response below so the frontend can show a
    // persistent "renew now" banner instead of a lockout screen.
    if (accountType === 'landlord' && account.subscription_status === 'suspended') {
      return res.status(403).json({ error: 'Your account has been suspended. Contact RentaPay support for more information.', suspended: true });
    }

    // THE FIX for "the landlord's account is already activated even
    // though payment was never confirmed": a landlord account is now
    // verified ONLY by activateLandlordAfterPayment() - i.e. only
    // after Daraja or an admin actually confirms the subscription
    // payment (no OTP is involved anywhere in this anymore - payment
    // confirmation IS the verification). A landlord whose payment is
    // still pending gets routed straight to the "awaiting payment
    // confirmation" screen below instead of any kind of code-entry
    // screen, since there is no code to enter. Checked here, before
    // the is_verified branch, so it applies
    // whether or not is_verified happens to already be (wrongly) true
    // from before this fix. This never blocks re-entry: instead it
    // hands back enough to resume the same "waiting for payment"
    // screen the registration wizard itself uses.
    if (accountType === 'landlord' && account.subscription_status === 'pending') {
      supabase.from(table).update({ failed_login_attempts: 0, locked_until: null }).eq('id', account.id)
        .then(({ error: resetErr }) => { if (resetErr) console.error('[auth] login: failed to reset attempt counter (non-fatal):', resetErr.message); });

      const { data: latestPayment } = await supabase
        .from('subscription_payments')
        .select('mpesa_checkout_request_id, amount')
        .eq('landlord_id', account.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let amountDue = latestPayment?.amount ?? null;
      if (amountDue == null) {
        try {
          amountDue = calculateSubscriptionCost(account.unit_limit, account.subscription_period_months).totalCost;
        } catch {
          amountDue = null;
        }
      }

      return res.status(200).json({
        paymentPending: true,
        landlordId: account.id,
        checkoutRequestId: latestPayment?.mpesa_checkout_request_id || null,
        amountDue,
        phone: account[phoneField],
        message: 'Your subscription payment has not been confirmed yet. Complete or verify your payment to continue.',
      });
    }

    let subscriptionExpired = accountType === 'landlord' && account.subscription_status === 'expired';

    if (accountType === 'manager') {
      if (account.is_active === false) {
        return res.status(403).json({ error: 'Your property manager access has been removed. Contact the landlord for more information.', suspended: true });
      }
      const { data: parentLandlord } = await supabase
        .from('landlords')
        .select('subscription_status')
        .eq('id', account.landlord_id)
        .maybeSingle();
      // Same distinction as above: only a real admin ban on the
      // landlord blocks their managers/caretakers from logging in.
      // An expired subscription does not - they can still log in and
      // will see the same renew-now banner the landlord sees.
      if (parentLandlord?.subscription_status === 'suspended') {
        return res.status(403).json({ error: "The landlord's account has been suspended. Contact RentaPay support for more information.", suspended: true });
      }
      subscriptionExpired = parentLandlord?.subscription_status === 'expired';
    }

    // Scout accounts have no single account-level subscription status
    // (per-county subscriptions live in scout_county_subscriptions,
    // checked server-side per Phase 5a whenever they browse - not
    // here). The only thing that can block login itself is an admin
    // deliberately deactivating the account, same meaning as a
    // manager's is_active.
    if (accountType === 'scout' && account.is_active === false) {
      return res.status(403).json({ error: 'Your Scout account has been deactivated. Contact RentaPay support for more information.', suspended: true });
    }

    // -----------------------------------------------------------------
    // DEV-ONLY DIAGNOSTIC - set DEBUG_AUTH=true in .env to enable.
    // Logs exactly what the query returned and what bcrypt.compare()
    // is about to test, WITHOUT ever printing the plaintext password
    // or the account's real password_hash in full (hash is truncated
    // and the input password is masked - the shape of the hash is
    // enough to diagnose a plaintext-vs-bcrypt mismatch without
    // leaking anything sensitive into your terminal/logs).
    //
    // Hard-gated to never run when NODE_ENV === 'production', even if
    // DEBUG_AUTH is accidentally left set - this should never ship.
    // -----------------------------------------------------------------
    if (process.env.DEBUG_AUTH === 'true' && process.env.NODE_ENV !== 'production') {
      const hash = account.password_hash || '';
      const looksLikeBcrypt = /^\$2[aby]\$\d{2}\$/.test(hash);
      console.log('[auth][DEBUG_AUTH] ----------------------------------------');
      console.log('[auth][DEBUG_AUTH] Query returned account:', { id: account.id, phone: account[phoneField], is_verified: account.is_verified });
      console.log('[auth][DEBUG_AUTH] password_hash length:', hash.length, '| starts with:', hash.slice(0, 7) + '...');
      console.log('[auth][DEBUG_AUTH] Looks like a real bcrypt hash ($2a/$2b/$2y$ + cost):', looksLikeBcrypt);
      if (!looksLikeBcrypt) {
        console.log(
          '[auth][DEBUG_AUTH] *** This is almost certainly your bug. ***',
          'password_hash does not match bcrypt\'s format. If you inserted',
          'a plaintext password directly into Supabase, bcrypt.compare()',
          'will ALWAYS return false against it, regardless of what the',
          'user types. Run it through hashPassword() first - see the',
          'normalization steps in the chat response.'
        );
      }
      console.log('[auth][DEBUG_AUTH] Submitted password length:', (password || '').length, '(value masked)');
      console.log('[auth][DEBUG_AUTH] ----------------------------------------');
    }

    const passwordMatches = await comparePassword(password, account.password_hash);

    if (!passwordMatches) {
      const newAttempts = (account.failed_login_attempts || 0) + 1;
      const updateFields = { failed_login_attempts: newAttempts };

      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        const lockUntil = new Date();
        lockUntil.setMinutes(lockUntil.getMinutes() + LOCKOUT_MINUTES);
        updateFields.locked_until = lockUntil.toISOString();
      }

      await supabase.from(table).update(updateFields).eq('id', account.id);
      return res.status(401).json({ error: invalidCredsMsg });
    }

    // -----------------------------------------------------------------
    // FIX: password is checked BEFORE the verification check now (it
    // used to be the other way round, which meant an unverified
    // account never got its credentials confirmed at all before being
    // bounced with a bare 403). More importantly: instead of dead-
    // ending here, a correct password on an unverified account now
    // auto-sends a fresh OTP and returns the account's real ID, so the
    // frontend can jump the tenant/landlord straight to an OTP-entry
    // screen. Previously the only recovery path was a separate
    // "verify account" page that required requesting a new code
    // first to even learn the accountId - if a person skipped that
    // and pasted in the OTP they'd already received by SMS, the
    // verify call had no accountId to match against and failed with
    // "no matching account found", even though the OTP itself was
    // valid. Reusing the still-valid OTP the tenant already has (if
    // it hasn't expired) avoids invalidating an SMS they've already
    // received; a new one is only generated if needed.
    // -----------------------------------------------------------------
    if (!account.is_verified && accountType !== 'landlord') {
      let otpToSend = account.otp_code;
      const otpStillValid = otpToSend && !isOTPExpired(account.otp_expires_at);

      if (!otpStillValid) {
        otpToSend = generateOTP();
        const otpExpiresAt = getOTPExpiry();
        await supabase.from(table).update({ otp_code: otpToSend, otp_expires_at: otpExpiresAt.toISOString() }).eq('id', account.id);
        if (account.email) {
          await sendEmail(account.email, 'Your RentaPay verification code', wrapEmailHtml(templates.otpMessage(otpToSend)));
        } else {
          console.warn(`[auth] login: cannot send OTP - no email on file for ${accountType} ${account.id}`);
        }
      }

      await supabase.from(table).update({ failed_login_attempts: 0, locked_until: null }).eq('id', account.id);

      return res.status(200).json({
        needsVerification: true,
        accountType,
        accountId: account.id,
        phone,
        message: otpStillValid
          ? 'Your account still needs to be verified. Enter the code already sent to your email.'
          : 'Your account needs to be verified. A new code has been sent to your email.',
      });
    }

    // PERFORMANCE FIX (direct request: logging in "takes too long...
    // to enter the portal if [credentials] are correct"): this used
    // to `await` the failed-attempts-reset write before responding -
    // a full extra database round-trip sitting directly in the path
    // of every single successful login, for a write whose result the
    // person never needed to wait on. Fired without awaiting instead;
    // the token comes back the moment bcrypt confirms the password,
    // and this write finishes in the background a moment later.
    supabase.from(table).update({ failed_login_attempts: 0, locked_until: null }).eq('id', account.id)
      .then(({ error: resetErr }) => { if (resetErr) console.error('[auth] login: failed to reset attempt counter (non-fatal):', resetErr.message); });

    const token = signToken(
      accountType === 'manager'
        ? { id: account.id, role: accountType, landlordId: account.landlord_id, roleLevel: account.role_level || 'manager' }
        : { id: account.id, role: accountType }
    );

    return res.json({
      token,
      mustChangePassword: account.must_change_password || false,
      setupWizardComplete: accountType === 'landlord' ? account.setup_wizard_complete : undefined,
      role: accountType,
      roleLevel: accountType === 'manager' ? account.role_level || 'manager' : undefined,
      subscriptionExpired,
      // Always the account's real phone number, regardless of whether
      // the person signed in with it or with their email - the
      // frontend needs this for its own session state either way.
      phone: account[phoneField],
    });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    return res.status(500).json({ error: 'Failed to log in.' });
  }
}

// ---------------------------------------------------------------------
// SUPER ADMIN LOGIN (blueprint 13.3 - hardcoded single account, 2FA)
// ---------------------------------------------------------------------
async function adminLogin(req, res) {
  try {
    const { password } = req.body;
    const adminPasswordHash = process.env.SUPER_ADMIN_PASSWORD_HASH;
    const adminEmail = process.env.SUPER_ADMIN_EMAIL || SUPPORT_EMAIL;

    if (!adminPasswordHash) {
      return res.status(500).json({ error: 'Super admin account not configured. Set SUPER_ADMIN_PASSWORD_HASH in .env.' });
    }

    const matches = await comparePassword(password, adminPasswordHash);
    if (!matches) {
      try {
        await sendEmail(adminEmail, 'RentaPay Admin Alert', wrapEmailHtml('A WRONG password attempt was just made on the admin panel.'));
      } catch (emailErr) {
        console.warn('[auth] adminLogin: wrong-password alert email failed (non-fatal):', emailErr.message);
      }
      return res.status(401).json({ error: 'Invalid password.' });
    }

    // DIRECT REQUEST: communications (SMS/email) aren't fully set up
    // yet, so the admin OTP step is disabled for now via env flag -
    // set SUPER_ADMIN_OTP_ENABLED=true in .env whenever ready to turn
    // 2FA back on for production, no code change needed either way.
    const otpEnabled = String(process.env.SUPER_ADMIN_OTP_ENABLED || '').toLowerCase() === 'true';
    if (!otpEnabled) {
      const token = signToken({ id: 'super-admin', role: 'admin' });
      logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'admin_login', metadata: { otpSkipped: true }, ipAddress: req.ip });
      return res.json({ token, role: 'admin', otpSkipped: true, message: 'Password correct. OTP is currently disabled - logged in directly.' });
    }

    // Issue a short-lived OTP for 2FA (blueprint 13.3: expires in 5 minutes)
    const otp = generateOTP();
    global.__adminOtpStore = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

    try {
      await sendEmail(adminEmail, 'Your RentaPay admin verification code', wrapEmailHtml(templates.adminOtpMessage(otp)));
    } catch (emailErr) {
      // Without this catch, any email failure (unverified Resend
      // domain, network issue, etc) would 500 the whole request and
      // the OTP - which WAS generated and stored above - would never
      // be shown to the admin anywhere, leaving them stuck with no
      // way to get in. Log it loudly since this IS the actual
      // delivery mechanism for the OTP; the admin needs another way
      // to see it when email is broken.
      console.error('[auth] adminLogin: OTP email failed to send. OTP is still valid - check here:', otp, '| Error:', emailErr.message);
    }

    return res.json({ message: 'Password correct. OTP sent to admin email, expires in 5 minutes.' });
  } catch (err) {
    console.error('[auth] adminLogin error:', err.message);
    return res.status(500).json({ error: 'Failed to log in.' });
  }
}

async function adminVerifyOTP(req, res) {
  try {
    const { otp } = req.body;
    const store = global.__adminOtpStore;

    if (!store || store.otp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP.' });
    }
    if (Date.now() > store.expiresAt) {
      return res.status(400).json({ error: 'OTP expired. Please log in again.' });
    }

    global.__adminOtpStore = null;
    const token = signToken({ id: 'super-admin', role: 'admin' });

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'admin_login', ipAddress: req.ip });

    return res.json({ token, role: 'admin' });
  } catch (err) {
    console.error('[auth] adminVerifyOTP error:', err.message);
    return res.status(500).json({ error: 'Failed to verify admin OTP.' });
  }
}

// ---------------------------------------------------------------------
// MARK SETUP WIZARD COMPLETE (blueprint 3.2 step 5: "Dashboard unlocked")
// ---------------------------------------------------------------------
// Without this, login()'s setupWizardComplete check (used by the
// frontend to decide whether to redirect back into the wizard) would
// never become true - finishing the wizard UI alone doesn't persist
// anything server-side, so every future login would bounce the
// landlord back into RegisterFlow forever. Called from the frontend's
// final wizard step once units/property/payment-method are saved.
async function completeSetupWizard(req, res) {
  try {
    const landlordId = req.user.id; // requires verifyToken middleware
    const { gender } = req.body;

    // Direct request: ask for gender during setup so the portal can
    // show "Landlord" or "Landlady" correctly from day one instead of
    // defaulting everyone to the male-coded label. Still optional here
    // (frontend prompts for it, but a landlord who skips it can set it
    // later in Settings via updateMyContact) - not required so setup
    // can never dead-end for someone who declines to answer.
    const updateFields = { setup_wizard_complete: true };
    if (gender !== undefined && gender !== null) {
      if (!['male', 'female'].includes(gender)) {
        return res.status(400).json({ error: "gender must be 'male' or 'female'." });
      }
      updateFields.gender = gender;
    }

    const { error } = await supabase.from('landlords').update(updateFields).eq('id', landlordId);
    if (error) throw error;

    logActivity({ actorType: 'landlord', actorId: landlordId, action: 'setup_wizard_completed', targetType: 'landlord', targetId: landlordId });

    return res.json({ message: 'Setup wizard marked complete.' });
  } catch (err) {
    console.error('[auth] completeSetupWizard error:', err.message);
    return res.status(500).json({ error: 'Failed to mark setup wizard as complete.' });
  }
}

// ---------------------------------------------------------------------
// UPDATE PROPERTY DETAILS (Setup Wizard step 1 - blueprint 3.2)
// ---------------------------------------------------------------------
// Previously nothing in the system ever wrote estate_name/location/
// county/description - the wizard's property step only updated local
// React state and moved on. This is the real persistence endpoint for
// that step.
async function updatePropertyDetails(req, res) {
  try {
    const landlordId = req.user.id; // requires verifyToken middleware
    const { estateName, location, county, constituency, description } = req.body;

    if (!estateName || !location || !county || !constituency) {
      return res.status(400).json({ error: 'estateName, location, county, and constituency are required.' });
    }

    if (!KENYA_COUNTIES.includes(county)) {
      return res.status(400).json({ error: 'Please select a valid county.' });
    }

    // Constituency must belong to the chosen county - same reasoning
    // as county being a fixed dropdown instead of free text: a
    // mismatched pair (e.g. a Nairobi constituency saved against
    // Mombasa) would silently break Phase 5's per-constituency
    // filtering later.
    if (!(KENYA_CONSTITUENCIES[county] || []).includes(constituency)) {
      return res.status(400).json({ error: 'Please select a constituency that belongs to the chosen county.' });
    }

    const { error } = await supabase
      .from('landlords')
      .update({
        estate_name: estateName,
        location,
        county,
        constituency,
        description: description || null,
      })
      .eq('id', landlordId);

    if (error) throw error;

    logActivity({ actorType: 'landlord', actorId: landlordId, action: 'property_details_updated', targetType: 'landlord', targetId: landlordId });

    return res.json({ message: 'Property details saved.' });
  } catch (err) {
    console.error('[auth] updatePropertyDetails error:', err.message);
    return res.status(500).json({ error: 'Failed to save property details.' });
  }
}

// ---------------------------------------------------------------------
// GET MY OWN PROFILE (landlord only) - contact details + payment
// method, exactly as currently saved. THE FIX: Settings.jsx previously
// had no way to load this at all - the Contact Details and Payment
// Method forms always rendered blank/default (payment method always
// showing "STK Push" even if the landlord had actually set Paybill),
// because nothing ever fetched the landlord's own saved values. This
// is the missing GET counterpart to updateMyContact/updatePaymentMethod.
// ---------------------------------------------------------------------
async function getMyLandlordProfile(req, res) {
  try {
    const landlordId = req.user.id;
    const { data: landlord, error } = await supabase
      .from('landlords')
      .select('id, full_name, phone, email, photo_url, payment_method, paybill_number, paybill_account_number, till_number, gender, notification_style')
      .eq('id', landlordId)
      .single();
    if (error || !landlord) return res.status(404).json({ error: 'Account not found.' });

    return res.json({
      contact: {
        fullName: landlord.full_name,
        phone: landlord.phone,
        email: landlord.email || '',
        gender: landlord.gender || null,
        notificationStyle: landlord.notification_style || 'ring',
      },
      paymentMethod: {
        method: landlord.payment_method || 'stk',
        paybillNumber: landlord.paybill_number || '',
        accountNumber: landlord.paybill_account_number || '',
        tillNumber: landlord.till_number || '',
      },
      photoUrl: landlord.photo_url,
    });
  } catch (err) {
    console.error('[auth] getMyLandlordProfile error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch your profile.' });
  }
}

// ---------------------------------------------------------------------
// GET PAYMENT METHOD (read-only, for any role attached to the
// account - landlord, manager, caretaker). Separate from
// getMyLandlordProfile (which is landlord-only and includes their own
// contact details too) because managers/caretakers need to see the
// payment method without exposing/needing the landlord's personal
// contact info, and effectiveLandlordId() (not req.user.id) has to be
// used since a manager's own id is never a landlords.id.
// ---------------------------------------------------------------------
async function getPaymentMethodForViewer(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId } = req.query;
    const { data: landlord, error } = await supabase
      .from('landlords')
      .select('payment_method, paybill_number, paybill_account_number, till_number, stk_phone_number')
      .eq('id', landlordId)
      .single();
    if (error || !landlord) return res.status(404).json({ error: 'Account not found.' });

    let property = null;
    if (propertyId) {
      const { data } = await supabase
        .from('properties')
        .select('payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, payment_override_stk_phone_number')
        .eq('id', propertyId)
        .eq('landlord_id', landlordId)
        .maybeSingle();
      property = data || null;
    }

    const overridden = !!(property && property.payment_override_enabled);
    const source = overridden ? {
      method: property.payment_override_method,
      paybill_number: property.payment_override_paybill_number,
      paybill_account_number: property.payment_override_paybill_account_number,
      till_number: property.payment_override_till_number,
      stk_phone_number: property.payment_override_stk_phone_number,
    } : landlord;

    return res.json({
      paymentMethod: {
        method: source.payment_method || source.method || 'stk',
        paybillNumber: (overridden ? source.paybill_number : landlord.paybill_number) || '',
        accountNumber: (overridden ? source.paybill_account_number : landlord.paybill_account_number) || '',
        tillNumber: (overridden ? source.till_number : landlord.till_number) || '',
        stkPhoneNumber: (overridden ? source.stk_phone_number : landlord.stk_phone_number) || '',
        isApartmentSpecific: overridden,
      },
    });
  } catch (err) {
    console.error('[auth] getPaymentMethodForViewer error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch payment method.' });
  }
}

// ---------------------------------------------------------------------
// UPDATE MY OWN CONTACT DETAILS (landlord only - a property manager
// edits their own contact via PATCH /api/property-managers/:managerId
// instead, see propertyManager.controller.js). Separate from
// updatePropertyDetails above, which is about the rental property's
// own name/location, not the landlord's personal contact info. This
// is what feeds the "Contact Details" card in Settings, and - via
// properties.primary_contact_manager_id - whichever number a tenant
// sees for their property.
// ---------------------------------------------------------------------
async function updateMyContact(req, res) {
  try {
    const landlordId = req.user.id;
    const { fullName, email, gender, notificationStyle } = req.body;
    let { phone } = req.body;

    const updateFields = {};
    if (fullName !== undefined) {
      if (!fullName.trim()) return res.status(400).json({ error: 'Full name cannot be empty.' });
      updateFields.full_name = fullName.trim();
    }
    if (email !== undefined) updateFields.email = email || null;
    // Drives the "Landlord" vs "Landlady" label shown across the
    // portal (direct request, to avoid assuming every property owner
    // is a man). Optional and settable/changeable any time here, not
    // just once during setup.
    if (gender !== undefined) {
      if (gender !== null && !['male', 'female'].includes(gender)) {
        return res.status(400).json({ error: "gender must be 'male', 'female', or null." });
      }
      updateFields.gender = gender;
    }
    // Direct request: "notifications should be default according to
    // the user profiles - if its vibrate they vibrate if ring they
    // ring". Controls the push payload's vibrate/silent flags - see
    // webpush.service.js.
    if (notificationStyle !== undefined) {
      if (!['ring', 'vibrate', 'silent'].includes(notificationStyle)) {
        return res.status(400).json({ error: "notificationStyle must be 'ring', 'vibrate', or 'silent'." });
      }
      updateFields.notification_style = notificationStyle;
    }
    if (phone !== undefined) {
      try {
        updateFields.phone = normalizePhoneOrThrow(phone, 'Phone number');
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
    }

    if (!Object.keys(updateFields).length) return res.status(400).json({ error: 'No fields to update.' });

    const { data: updated, error } = await supabase.from('landlords').update(updateFields).eq('id', landlordId).select('id, full_name, phone, email, gender, notification_style').single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That phone number is already in use by another account.' });
      throw error;
    }

    logActivity({ actorType: 'landlord', actorId: landlordId, action: 'contact_details_updated', targetType: 'landlord', targetId: landlordId });

    return res.json({ message: 'Contact details updated.', contact: updated });
  } catch (err) {
    console.error('[auth] updateMyContact error:', err.message);
    return res.status(500).json({ error: 'Failed to update contact details.' });
  }
}

// ---------------------------------------------------------------------
// UPDATE PAYMENT METHOD (Setup Wizard step 2 - blueprint 3.2)
//
// BUG FIX: this used to always write to the landlords table, which
// every apartment a landlord owns reads from - so editing "the"
// payment method while looking at Apartment A silently changed
// Apartment B's payment method too. Now: an optional `propertyId` in
// the body scopes the write to that one apartment's override
// (properties.payment_override_* - see
// 2026-07-property-payment-method.sql) instead of the landlord's
// shared default. Omitting propertyId still updates the landlord-wide
// default, exactly as before, for accounts with only one apartment or
// for deliberately changing the fallback every apartment inherits.
//
// Also opened up to property managers (not just the landlord account
// itself), since item 9/12 asks for managers to have the same power -
// scoped via effectiveLandlordId + ownership check on propertyId.
// ---------------------------------------------------------------------
async function updatePaymentMethod(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { method, paybillNumber, accountNumber, tillNumber, stkPhoneNumber, propertyId, useDefault } = req.body;

    if (!useDefault && !['stk', 'paybill', 'till'].includes(method)) {
      return res.status(400).json({ error: "method must be 'stk', 'paybill', or 'till'." });
    }

    const methodLabel = (m, pb, acc, till) => (m === 'paybill'
      ? `Paybill ${pb || ''}${acc ? ` (Account: ${acc})` : ''}`
      : m === 'till'
        ? `Till Number ${till || ''}`
        : 'STK Push');

    let propertyName = null;
    let previousLabel;
    let newLabel;
    let notifyOptions = {};

    if (propertyId) {
      // Confirm this property actually belongs to the caller's
      // landlord account before letting them touch it.
      const { data: property, error: propErr } = await supabase
        .from('properties')
        .select('id, name, landlord_id, payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number')
        .eq('id', propertyId)
        .eq('landlord_id', landlordId)
        .maybeSingle();
      if (propErr) throw propErr;
      if (!property) return res.status(404).json({ error: 'Apartment not found on your account.' });
      propertyName = property.name;

      const { data: landlordRow } = await supabase.from('landlords').select('payment_method, paybill_number, paybill_account_number, till_number').eq('id', landlordId).single();
      previousLabel = property.payment_override_enabled
        ? methodLabel(property.payment_override_method, property.payment_override_paybill_number, property.payment_override_paybill_account_number, property.payment_override_till_number)
        : `${methodLabel(landlordRow.payment_method, landlordRow.paybill_number, landlordRow.paybill_account_number, landlordRow.till_number)} (account default)`;

      if (useDefault) {
        const { error } = await supabase.from('properties').update({ payment_override_enabled: false }).eq('id', propertyId);
        if (error) throw error;
        newLabel = `${methodLabel(landlordRow.payment_method, landlordRow.paybill_number, landlordRow.paybill_account_number, landlordRow.till_number)} (account default)`;
      } else {
        const { error } = await supabase
          .from('properties')
          .update({
            payment_override_enabled: true,
            payment_override_method: method,
            payment_override_paybill_number: paybillNumber || null,
            payment_override_paybill_account_number: accountNumber || null,
            payment_override_till_number: tillNumber || null,
            payment_override_stk_phone_number: stkPhoneNumber || null,
          })
          .eq('id', propertyId);
        if (error) throw error;
        newLabel = methodLabel(method, paybillNumber, accountNumber, tillNumber);
      }

      // Notify only members of THIS apartment - not the landlord's
      // whole account - and postSystemAnnouncement's own
      // audience='property' + property_id filtering (see
      // listAnnouncements) already naturally excludes units that have
      // their OWN unit-level override, because from their perspective
      // this apartment-level change doesn't affect what they see.
      notifyOptions = { propertyId };
    } else {
      const { error } = await supabase
        .from('landlords')
        .update({
          payment_method: method,
          paybill_number: paybillNumber || null,
          paybill_account_number: accountNumber || null,
          till_number: tillNumber || null,
          stk_phone_number: stkPhoneNumber || null,
        })
        .eq('id', landlordId);
      if (error) throw error;
      newLabel = methodLabel(method, paybillNumber, accountNumber, tillNumber);
      previousLabel = null; // account-wide default; not worth diffing every apartment's inherited view
    }

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'payment_method_updated', targetType: 'landlord', targetId: landlordId });

    // Item 10: name who did it and what changed, not just "the
    // payment method has been updated".
    const actor = await getActorDisplay(req);
    const scopeText = propertyName ? ` for ${propertyName}` : '';
    const changeText = previousLabel ? `from ${previousLabel} to ${newLabel}` : `to ${newLabel}`;
    await postSystemAnnouncement(landlordId, `Your ${actor.roleLabel} ${actor.name} updated the payment method${scopeText} ${changeText}.`, notifyOptions);

    return res.json({ message: 'Payment method saved.' });
  } catch (err) {
    console.error('[auth] updatePaymentMethod error:', err.message);
    return res.status(500).json({ error: 'Failed to save payment method.' });
  }
}

// ---------------------------------------------------------------------
// RESEND OTP (real-world necessity: SMS can fail, get delayed, or the
// original OTP can expire after 24 hours with no way to get a new one
// otherwise - this was a genuine gap where a real user could get
// permanently stuck at "Account not verified" with no recovery path)
// ---------------------------------------------------------------------
async function resendOTP(req, res) {
  try {
    const { accountType } = req.body;
    let { phone } = req.body;

    if (!ALL_ACCOUNT_TYPES.includes(accountType)) {
      return res.status(400).json({ error: "accountType must be 'landlord', 'tenant', 'manager', or 'scout'." });
    }

    // DIRECT REQUEST FIX: a landlord account is never OTP-verified -
    // it's verified solely by payment confirmation (Daraja or admin
    // manual confirm - see activateLandlordAfterPayment). Reject this
    // explicitly rather than relying on it being harmless as a side
    // effect (it always ended up erroring anyway: "already verified"
    // once paid, "payment not confirmed" while still pending) - a
    // landlord's next real step is always the payment/registration
    // flow, not a text message.
    if (accountType === 'landlord') {
      return res.status(400).json({ error: 'Landlord accounts are verified automatically once your subscription payment is confirmed - there is no code to resend. If your payment is still pending, continue from the registration screen.' });
    }

    phone = normalizePhone(phone) || phone;

    const { table, phoneField } = accountTable(accountType);

    const { data: account, error } = await supabase.from(table).select('*').eq(phoneField, phone).maybeSingle();

    if (error || !account) {
      // Deliberately vague - don't reveal whether a phone number is
      // registered (avoids leaking account existence to an attacker).
      return res.status(404).json({ error: 'No matching account found.' });
    }

    if (account.is_verified) {
      return res.status(400).json({ error: 'This account is already verified. Try logging in.' });
    }

    const otp = generateOTP();
    const otpExpiresAt = getOTPExpiry();

    await supabase.from(table).update({ otp_code: otp, otp_expires_at: otpExpiresAt.toISOString() }).eq('id', account.id);

    if (account.email) {
      try {
        await sendEmail(account.email, 'Your RentaPay verification code', wrapEmailHtml(templates.otpMessage(otp)));
      } catch (emailErr) {
        console.error('[auth] resendOTP: email send failed - this account has no other delivery channel:', emailErr.message);
      }
    } else {
      console.warn(`[auth] resendOTP: no email on file for ${accountType} ${account.id} - OTP has nowhere to be delivered.`);
    }

    logActivity({ actorType: 'system', action: 'otp_resent', targetType: accountType, targetId: account.id });

    return res.json({ message: 'A new verification code has been sent.', accountId: account.id });
  } catch (err) {
    console.error('[auth] resendOTP error:', err.message);
    return res.status(500).json({ error: 'Failed to resend verification code.' });
  }
}

// ---------------------------------------------------------------------
// CHANGE PASSWORD (landlord or tenant, authenticated) - THE MISSING
// PIECE: login() has always redirected a first-time login (temp
// password from tenant creation, or must_change_password on any
// account) to a /change-password screen, but neither this endpoint
// nor the frontend page it needs actually existed. With no route to
// land on, the frontend's catch-all silently bounced the person back
// to /login - which looked exactly like "won't log in", when the
// login itself was actually succeeding every time.
// ---------------------------------------------------------------------
async function changePassword(req, res) {
  try {
    const { id, role } = req.user; // from verifyToken - 'landlord', 'tenant', or 'manager' reach this route
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
    }

    const { table, phoneField } = accountTable(role);

    const { data: account, error } = await supabase.from(table).select('*').eq('id', id).single();
    if (error || !account) return res.status(404).json({ error: 'Account not found.' });

    const currentMatches = await comparePassword(currentPassword, account.password_hash);
    if (!currentMatches) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const { isValid, errors } = validatePasswordStrength(newPassword, { phone: account[phoneField], name: account.full_name });
    if (!isValid) {
      return res.status(400).json({ error: errors.join(' ') });
    }

    const newHash = await hashPassword(newPassword);
    const { error: updateError } = await supabase
      .from(table)
      .update({ password_hash: newHash, must_change_password: false })
      .eq('id', id);

    if (updateError) throw updateError;

    // THE FIX: notify the person on their registered number whenever
    // their password changes - important both as a "was this really
    // me?" security signal, and because a landlord force-resetting a
    // tenant's password (or anyone resetting via forgot-password)
    // previously left the account holder with no way to know it had
    // happened at all. Never let a delivery failure here undo an
    // already-successful password change - it's logged, not thrown.
    try {
      if (account.email) {
        await sendEmail(account.email, 'Your RentaPay password was changed', wrapEmailHtml(templates.passwordChanged(account.full_name)));
      }
    } catch (emailErr) {
      console.warn('[auth] changePassword: confirmation email failed (non-fatal, password was already changed):', emailErr.message);
    }

    logActivity({ actorType: role, actorId: id, action: 'password_changed', targetType: role, targetId: id });

    return res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    console.error('[auth] changePassword error:', err.message);
    return res.status(500).json({ error: 'Failed to change password.' });
  }
}

// ---------------------------------------------------------------------
// FORGOT PASSWORD (landlord or tenant, NOT authenticated - this is
// exactly for someone who's locked out and can't get a token). Two
// steps: request a reset code by phone, then submit that code + a new
// password. Reuses the same otp_code/otp_expires_at columns as
// account verification - fine, since the two purposes never overlap
// in time for a given account (you can't be mid-reset and mid-verify
// at once), and it means no new columns needed.
// ---------------------------------------------------------------------
async function requestPasswordReset(req, res) {
  try {
    let { email, phone, accountType } = req.body;

    // PASSWORD RESET UNIFICATION: accountType is now optional, same as
    // login(). Unlike login, there's no password yet at this step to
    // silently disambiguate a dual-role account with, so every matched
    // account type gets the exact same reset code written to it - the
    // *next* step (resetPassword, below) is where a genuinely ambiguous
    // case gets resolved, by reusing login()'s account-picker pattern.
    //
    // LOOKUP BY EITHER PHONE OR EMAIL, SAME AS login(): not everyone
    // remembers the email they registered with, so this now mirrors
    // login()'s "whichever the person finds easier" behavior instead of
    // forcing email specifically. The reset code is still always
    // DELIVERED to the account's email (that part hasn't changed - it's
    // just no longer the only way to look the account up).
    if (accountType && !ALL_ACCOUNT_TYPES.includes(accountType)) {
      return res.status(400).json({ error: "accountType, if provided, must be 'landlord', 'manager', 'tenant', or 'scout'." });
    }
    const usingPhone = !email && !!phone;
    if (!email && !phone) {
      return res.status(400).json({ error: 'phone (or email) is required.' });
    }

    if (usingPhone) {
      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone) phone = normalizedPhone;
    } else {
      email = String(email).trim();
    }

    let matches;
    if (accountType) {
      const { table, phoneField } = accountTable(accountType);
      const { data } = usingPhone
        ? await supabase.from(table).select('*').eq(phoneField, phone).maybeSingle()
        : await supabase.from(table).select('*').ilike('email', email).maybeSingle();
      matches = data ? [{ accountType, account: data }] : [];
    } else {
      matches = usingPhone ? await findAccountsByPhone(phone) : await findAccountsByEmail(email);
    }

    // Deliberately return the same success message regardless of how
    // many (if any) accounts matched - so this endpoint can't be used
    // to check which email addresses are registered, or how many
    // account types a given email has. The OTP is only actually sent
    // if at least one account was found.
    if (matches.length > 0) {
      const otp = generateOTP();
      const otpExpiresAt = getPasswordResetOTPExpiry();

      // Same code written to every matched account. For the common
      // single-match case this is identical to before. For a dual-role
      // email, the SAME code will later unlock whichever account(s)
      // it's actually correct against - resetPassword() decides what
      // to do with that.
      await Promise.all(
        matches.map(({ accountType: at, account }) => {
          const { table } = accountTable(at);
          return supabase.from(table).update({ otp_code: otp, otp_expires_at: otpExpiresAt.toISOString() }).eq('id', account.id);
        })
      );
      // Sent to the registered email itself - this IS the identifier
      // that was matched on, so it's always present (unlike phone,
      // which was never guaranteed to be on file).
      await Promise.all(
        matches.map(({ account }) =>
          sendEmail(account.email, 'Your RentaPay password reset code', wrapEmailHtml(templates.passwordResetOtpMessage(otp)))
            .catch((emailErr) => console.error('[auth] requestPasswordReset: email send failed for account', account.id, ':', emailErr.message))
        )
      );

      // DIRECT REQUEST: recoverable from the admin portal (and the
      // landlord's own portal for their tenants/managers/caretakers)
      // in case the email never arrives. One row per matched account,
      // so a dual-role reset still shows up under both identities.
      await Promise.all(
        matches.map(async ({ accountType: at, account }) => {
          const loggedRole = at === 'manager' && account.role_level === 'caretaker' ? 'caretaker' : at;
          const { phoneField } = accountTable(at);
          try {
            await supabase.from('password_reset_requests').insert({
              landlord_id: at === 'landlord' ? null : account.landlord_id ?? null,
              role: loggedRole,
              account_id: account.id,
              full_name: account.full_name,
              phone: account[phoneField] || '',
              otp,
              expires_at: otpExpiresAt.toISOString(),
            });
          } catch (logErr) {
            // Never let this recovery-log write block the actual reset
            // flow - the OTP has already been generated and sent above.
            console.warn('[auth] requestPasswordReset: failed to log to password_reset_requests (non-fatal):', logErr.message);
          }
        })
      );
    }

    return res.json({ message: 'If that phone number or email is registered, a reset code has been sent to the account\u2019s email.' });
  } catch (err) {
    console.error('[auth] requestPasswordReset error:', err.message);
    return res.status(500).json({ error: 'Failed to process reset request.' });
  }
}

async function resetPassword(req, res) {
  try {
    let { email, phone, accountType, otp, newPassword } = req.body;

    if (accountType && !ALL_ACCOUNT_TYPES.includes(accountType)) {
      return res.status(400).json({ error: "accountType, if provided, must be 'landlord', 'manager', 'tenant', or 'scout'." });
    }
    // LOOKUP BY EITHER PHONE OR EMAIL, SAME AS requestPasswordReset:
    // whichever identifier the person used to request the code is the
    // one the frontend resubmits here, so this step has to accept both
    // too or a perfectly valid phone-based request would fail at the
    // final step.
    const usingPhone = !email && !!phone;
    if ((!email && !phone) || !otp || !newPassword) {
      return res.status(400).json({ error: 'phone (or email), otp, and newPassword are required.' });
    }

    if (usingPhone) {
      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone) phone = normalizedPhone;
    } else {
      email = String(email).trim();
    }

    // Same error either way (account not found vs wrong OTP) so this
    // can't be used to confirm which accounts exist.
    const genericError = { error: 'Invalid code.' };

    let matches;
    if (accountType) {
      // Disambiguation re-submit from the account picker below (otp +
      // newPassword unchanged, accountType now attached).
      const { table, phoneField } = accountTable(accountType);
      const { data } = usingPhone
        ? await supabase.from(table).select('*').eq(phoneField, phone).maybeSingle()
        : await supabase.from(table).select('*').ilike('email', email).maybeSingle();
      matches = data ? [{ accountType, account: data }] : [];
    } else {
      matches = usingPhone ? await findAccountsByPhone(phone) : await findAccountsByEmail(email);
    }

    // Only accounts where this exact code is still valid count.
    const validMatches = matches.filter(({ account }) => account.otp_code && account.otp_code === otp && !isOTPExpired(account.otp_expires_at));

    if (validMatches.length === 0) {
      // Same "expired" distinction the single-account flow always
      // had - only shown when the code actually matches some account
      // but has gone stale, never used to confirm an account exists.
      const staleMatch = matches.find(({ account }) => account.otp_code && account.otp_code === otp);
      if (staleMatch) {
        return res.status(400).json({ error: 'That code has expired. Request a new one.' });
      }
      return res.status(400).json(genericError);
    }

    if (validMatches.length > 1) {
      // Genuinely ambiguous: the same reset code is valid on more than
      // one account type for this number (requestPasswordReset sent
      // it to all of them). Reuse the exact account-picker pattern
      // from login()'s dual-role case instead of a new UI - the
      // frontend re-submits reset with accountType attached, otp and
      // newPassword unchanged, landing back here with exactly one match.
      return res.status(200).json({
        needsAccountPicker: true,
        options: validMatches.map(({ accountType: at, account }) => ({ accountType: at, id: account.id, label: accountTypeLabel(at, account) })),
      });
    }

    const { accountType: resolvedType, account } = validMatches[0];
    const { table, phoneField } = accountTable(resolvedType);

    const { isValid, errors } = validatePasswordStrength(newPassword, { phone: account[phoneField], name: account.full_name });
    if (!isValid) {
      return res.status(400).json({ error: errors.join(' ') });
    }

    const newHash = await hashPassword(newPassword);
    const { error: updateError } = await supabase
      .from(table)
      .update({
        password_hash: newHash,
        otp_code: null,
        otp_expires_at: null,
        failed_login_attempts: 0,
        locked_until: null,
      })
      .eq('id', account.id);

    if (updateError) throw updateError;

    try {
      if (account.email) {
        await sendEmail(account.email, 'Your RentaPay password was reset', wrapEmailHtml(templates.passwordChanged(account.full_name)));
      }
    } catch (emailErr) {
      console.warn('[auth] resetPassword: confirmation email failed (non-fatal, password was already changed):', emailErr.message);
    }

    logActivity({ actorType: resolvedType, actorId: account.id, action: 'password_reset', targetType: resolvedType, targetId: account.id });

    return res.json({ message: 'Password reset successfully. You can now log in with your new password.' });
  } catch (err) {
    console.error('[auth] resetPassword error:', err.message);
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
}

module.exports = {
  registerLandlord,
  activateLandlordAfterPayment,
  verifyOTP,
  resendOTP,
  login,
  adminLogin,
  adminVerifyOTP,
  completeSetupWizard,
  getMyLandlordProfile,
  getPaymentMethodForViewer,
  updatePropertyDetails,
  updateMyContact,
  updatePaymentMethod,
  changePassword,
  requestPasswordReset,
  resetPassword,
  // Exported for scout.controller.js (Phase 4) to reuse the exact same
  // account-table mapping and cross-role phone lookup, rather than
  // re-implementing a second copy that could drift out of sync.
  accountTable,
  findAccountsByPhone,
  ALL_ACCOUNT_TYPES,
};
