// src/controllers/auth.controller.js
//
// Handles registration/login for landlords and tenants, matching the
// flows in blueprint 3.1 (Landlord Registration) and 4 (Tenant Onboarding).
// Note: tenant ACCOUNTS are created by landlords (see tenant.controller.js),
// this file just handles their login + OTP verification.

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { hashPassword, comparePassword, validatePasswordStrength } = require('../utils/password');
const { generateOTP, getOTPExpiry, getPasswordResetOTPExpiry, getEmailVerificationOTPExpiry, isOTPExpired } = require('../utils/otp');
const { normalizePhone, normalizePhoneOrThrow } = require('../utils/phone');
const { isValidEmail } = require('../utils/email');
const { findPhoneConflict } = require('../utils/phoneUniqueness');
const { findEmailConflict } = require('../utils/emailUniqueness');
const { checkAndRecordResend, clearResendAttempts } = require('../utils/resendRateLimit');
const { signToken, effectiveLandlordId } = require('../middleware/auth.middleware');
const { calculateSubscriptionCost } = require('../utils/pricing');
const { initiateSTKPush } = require('../services/daraja.service');
const { sendEmail, wrapEmailHtml, SUPPORT_EMAIL } = require('../services/email.service');
const templates = require('../services/notificationTemplates');
const { logActivity } = require('../services/activityLog.service');
const { postSystemAnnouncement, getActorDisplay } = require('./announcement.controller');
const { convertMatchingLeadForPhone } = require('./landlordLead.controller');
const { KENYA_COUNTIES } = require('../constants/kenyaCounties');
const { KENYA_CONSTITUENCIES } = require('../constants/kenyaConstituencies');
const { createCoveragePeriod } = require('../services/coveragePeriod.service');
const { OAuth2Client } = require('google-auth-library');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

// GOOGLE LOGIN (item 2 of the requested feature set). Client ID is
// public (it's the same value the frontend sends to Google itself),
// but is read from an env var rather than hardcoded so the same code
// works across dev/staging/prod without a code change - set
// GOOGLE_CLIENT_ID in backend/.env. verifyIdToken() below is what
// actually proves the token wasn't forged: it checks the token's
// signature against Google's public keys AND that its `aud` (audience)
// claim matches this exact client ID, so a token minted for some other
// app can't be replayed against RentaPay.
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_MINUTES = 15;
const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCKOUT_MINUTES = 15;

// Maps an accountType to its table + the column that stores its phone
// number. Centralized here so adding the 'manager' account type only
// needed one place to change instead of five near-identical ternaries.
function accountTable(accountType) {
  if (accountType === 'landlord') return { table: 'landlords', phoneField: 'phone' };
  if (accountType === 'manager') return { table: 'property_managers', phoneField: 'phone' };
  // PHASE 3 (BA portal): kept OUT of ALL_ACCOUNT_TYPES (see login()'s
  // handleBrandAmbassadorLogin) since brand_ambassadors has no
  // is_active column, but changePassword()/other requireRole('brand_
  // ambassador') routes call accountTable(req.user.role) directly with
  // an already-authenticated role, so it still needs a mapping here.
  if (accountType === 'brand_ambassador') return { table: 'brand_ambassadors', phoneField: 'phone' };
  // SECTION 3 (General Manager dedicated login): general_managers has
  // the same password_hash/must_change_password/is_active shape as
  // property_managers, so it slots straight into the generic
  // accountTable()-driven helpers (changePassword, forgot-password)
  // even though its actual LOGIN entry point is deliberately separate
  // (see generalManagerLogin below, not login()) - only the *table
  // lookup* is shared, never the login route/screen itself.
  if (accountType === 'general_manager') return { table: 'general_managers', phoneField: 'phone' };
  return { table: 'tenants', phoneField: 'primary_phone' };
}

// FEATURE (direct request: "suspending landlord/manager/caretaker/
// tenant accounts... suspending it means they can't log in and if
// they try to change the password it returns the error account
// suspended, and it doesn't send the OTP"): a separate, ToS-violation
// moderation suspension - distinct from a landlord's subscription
// lapsing (subscription_status = 'suspended'/'expired', checked
// elsewhere) and distinct from a manager's access being revoked
// (is_active = false). Applies uniformly to all three account types
// via the same suspended_permanently/suspended_until columns (see
// 2026-08-moderation-and-reports.sql). Checked FIRST, before any
// password/OTP logic runs at all, in login(), loginWithGoogle(), and
// every password-reset OTP-sending entry point - a suspended account
// gets nothing, not even a code.
function moderationSuspensionError(account) {
  if (account.suspended_permanently) {
    return { status: 403, body: { error: 'Your account has been suspended. Contact RentaPay support for more information.', accountSuspended: true } };
  }
  if (account.suspended_until && new Date(account.suspended_until) > new Date()) {
    return {
      status: 403,
      body: {
        error: `Your account has been temporarily suspended until ${new Date(account.suspended_until).toLocaleString()}. Contact RentaPay support for more information.`,
        accountSuspended: true,
        suspendedUntil: account.suspended_until,
      },
    };
  }
  return null;
}

// FIX (direct request: "after completing one step and submitted, even
// if one taps a back UI, next time he logs in it should bring him to
// his last step"): setup_wizard_complete was only ever a single
// boolean, so a landlord who'd already finished the Property step (or
// Property + Payment method) but never reached the final "All set"
// screen - e.g. they hit the browser back button, or just closed the
// tab - got dumped back at the START of the wizard (Property, step
// index 3) on their next login, no matter how far they'd actually
// gotten. This derives the furthest step they've actually completed
// from real server-side records (does a property exist? is a payment
// method set?) instead of a single flag, so login always resumes
// exactly where they left off. Returns null when there's nothing to
// resume (setup_wizard_complete already true, or not a landlord).
const REGISTER_STEP_PROPERTY = 3;
const REGISTER_STEP_PAYMENT_METHOD = 4;
const REGISTER_STEP_UNITS = 5;

async function computeLandlordResumeStep(landlord) {
  if (landlord.setup_wizard_complete) return null;

  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('landlord_id', landlord.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!property) {
    return { step: REGISTER_STEP_PROPERTY, defaultPropertyId: null };
  }

  // payment_method defaults to null until the landlord actually
  // chooses one on that step - a non-null value means it's done.
  if (!landlord.payment_method) {
    return { step: REGISTER_STEP_PAYMENT_METHOD, defaultPropertyId: property.id };
  }

  return { step: REGISTER_STEP_UNITS, defaultPropertyId: property.id };
}

// FEATURE (direct request: strict subscription tiers - "tenants:
// unaffected for 30 days after lapse. After 30 days unrenewed, tenants
// see a persistent 'RentaPay temporarily unavailable' error on
// login"): a landlord/manager/caretaker can still log in indefinitely
// once their subscription lapses (they just lose access to
// "services" - see subscriptionGate.js - and see a persistent renew
// banner), but a tenant's login itself is gated once the grace period
// runs out. subscription_expires_at IS the lapse timestamp - no
// separate column needed, since a subscription that's still 'active'
// never reaches this check, and one written 'expired' keeps
// subscription_expires_at pinned to the moment it lapsed (see
// subscriptionReminders.job.js). Renewing (by the landlord, a
// manager, OR a caretaker via manual payment - "any of the 3 renewing
// unlocks all three accounts") flips subscription_status back to
// 'active', which immediately clears this for every tenant on the
// account, same as it does for the landlord/manager/caretaker banner.
const TENANT_GRACE_PERIOD_DAYS = 30;
async function tenantSubscriptionUnavailableError(landlordId) {
  const { data: landlord } = await supabase
    .from('landlords')
    .select('subscription_status, subscription_expires_at')
    .eq('id', landlordId)
    .maybeSingle();
  if (!landlord || landlord.subscription_status !== 'expired' || !landlord.subscription_expires_at) return null;

  const lapsedAt = new Date(landlord.subscription_expires_at);
  const graceEndsAt = new Date(lapsedAt.getTime() + TENANT_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  if (new Date() < graceEndsAt) return null; // still within the 30-day grace period

  return {
    status: 403,
    body: {
      error: 'RentaPay is temporarily unavailable for this property. Please contact your landlord or property manager.',
      subscriptionUnavailable: true,
    },
  };
}


// ---------------------------------------------------------------------
// FEATURE (direct request: onboarding checklist for every role). One
// generic endpoint rather than four near-identical ones - which table
// to update is resolved from the caller's own authenticated role via
// accountTable() above, so this can't be used to dismiss anyone else's
// checklist.
// ---------------------------------------------------------------------
async function dismissOnboarding(req, res) {
  try {
    const { table } = accountTable(req.user.role);
    const { error } = await supabase.from(table).update({ onboarding_dismissed_at: new Date().toISOString() }).eq('id', req.user.id);
    if (error) throw error;
    return res.json({ message: 'Onboarding checklist dismissed.' });
  } catch (err) {
    logger.error('[auth] dismissOnboarding error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to dismiss onboarding checklist.' });
  }
}

const ALL_ACCOUNT_TYPES = ['landlord', 'manager', 'tenant'];

// LOGIN UNIFICATION: checks a phone number against every account type
// in one round-trip (fired in parallel, not sequentially - same
// perf reasoning as the lockdown-check-in-parallel fix below). Returns
// an array of matches - normally 0 or 1, occasionally 2+ (the
// dual-role case, e.g. a landlord who also has a separate property
// manager login).
// Each match: { accountType, account }.
async function findAccountsByPhone(phone) {
  const results = await Promise.all(
    ALL_ACCOUNT_TYPES.map((accountType) => {
      const { table, phoneField } = accountTable(accountType);
      // ARCHIVE FIX: scope to is_active accounts only (landlords have
      // no is_active column, so they're left unfiltered). Without
      // this, an archived tenant/manager row left behind with the
      // same phone as a newly re-added active one makes maybeSingle()
      // see two rows and error out - silently dropping the real,
      // active account from the match instead of just this table.
      // Filtering here also means an archived account's old
      // credentials are simply never looked up again.
      let query = supabase.from(table).select('*').eq(phoneField, phone);
      if (accountType !== 'landlord') query = query.eq('is_active', true);
      return query.maybeSingle();
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
      // Same ARCHIVE FIX as findAccountsByPhone above.
      let query = supabase.from(table).select('*').ilike('email', email);
      if (accountType !== 'landlord') query = query.eq('is_active', true);
      return query.maybeSingle();
    })
  );
  return ALL_ACCOUNT_TYPES
    .map((accountType, i) => ({ accountType, account: results[i].data }))
    .filter((r) => r.account && !results[ALL_ACCOUNT_TYPES.indexOf(r.accountType)].error);
}

// FEATURE (direct request): "Google login worked on one device, then a
// second device says no account is registered with this Google email."
// Gmail/Googlemail ignore dots in the local part and anything after a
// "+" (john.doe@gmail.com, johndoe@gmail.com and john+rent@gmail.com
// all deliver to the same inbox) - so it's possible to sign in on one
// device, then have Google's picker hand back a differently-dotted or
// aliased variant of that exact same mailbox on another device or
// after re-adding the account. A plain ilike match won't catch that.
// This normalizes the local part (lowercase, strip dots, drop
// everything from "+" onward) for gmail.com/googlemail.com addresses
// only - other providers don't share this behavior, so leaving them
// untouched avoids ever loosening the match into a false positive.
function normalizeEmailForMatch(email) {
  const trimmed = (email || '').trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at === -1) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return trimmed;
  const dePlussed = local.split('+')[0];
  const deDotted = dePlussed.replace(/\./g, '');
  return `${deDotted}@gmail.com`;
}

// Same shape as findAccountsByEmail, but falls back to the
// Gmail-alias-aware comparison above when the direct, indexed ilike
// lookup comes back empty - so email really is the reliable, primary
// identifier for Google login rather than something that can silently
// fail because of how Google's account picker happened to format it
// on a particular device.
async function findAccountsByEmailFlexible(email) {
  const direct = await findAccountsByEmail(email);
  if (direct.length > 0) return direct;

  const isGmail = /@(gmail|googlemail)\.com$/.test((email || '').trim().toLowerCase());
  if (!isGmail) return direct;

  const target = normalizeEmailForMatch(email);

  const results = await Promise.all(
    ALL_ACCOUNT_TYPES.map(async (accountType) => {
      const { table } = accountTable(accountType);
      let query = supabase.from(table).select('*').not('email', 'is', null);
      if (accountType !== 'landlord') query = query.eq('is_active', true);
      const { data, error } = await query;
      if (error || !data) return null;
      return data.find((row) => normalizeEmailForMatch(row.email) === target) || null;
    })
  );
  return ALL_ACCOUNT_TYPES
    .map((accountType, i) => ({ accountType, account: results[i] }))
    .filter((r) => r.account);
}

// Human label for the account picker shown on a dual-role login (Phase
// 2b/step 5). Kept out of the frontend so the backend - which already
// knows role_level for managers - is the single source of truth for
// how an account should be described.
function accountTypeLabel(accountType, account) {
  if (accountType === 'manager') return account.role_level === 'caretaker' ? 'Caretaker' : 'Property Manager';
  if (accountType === 'landlord') return 'Landlord';
  return 'Tenant';
}

// ---------------------------------------------------------------------
// LANDLORD REGISTRATION (blueprint 3.1)
// Step 1: collect details + chosen plan, trigger STK push for subscription
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// DIRECT REQUEST: a landlord must verify their email on the SAME page
// as their details, before continuing to payment - same as how a
// tenant confirms their email on the same page before submitting via
// the onboarding link. This REPLACES the old flow where the account
// was created first and an OTP was verified on a separate step/page
// afterward. Mirrors requestBaEmailVerification /
// confirmBaEmailVerification in brandAmbassador.controller.js exactly:
// keyed by the raw email string in landlord_registration_email_otps
// (see sql/add-landlord-registration-email-otps.sql), since no
// landlords row exists yet - the person hasn't submitted the form.
// ---------------------------------------------------------------------
async function requestLandlordEmailVerification(req, res) {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    // Same courtesy as the old post-registration flow: catch an
    // already-used email here, before any code is sent, rather than
    // letting the landlord verify an address they can't register with
    // anyway.
    const conflictEmail = await findEmailConflict(normalizedEmail, 'landlord');
    if (conflictEmail) return res.status(409).json({ error: conflictEmail });

    const otp = generateOTP();
    const expiresAt = getEmailVerificationOTPExpiry();

    const { error: upsertErr } = await supabase
      .from('landlord_registration_email_otps')
      .upsert(
        {
          email: normalizedEmail,
          otp_code: otp,
          expires_at: expiresAt.toISOString(),
          verified: false,
          verification_token: null,
          failed_attempts: 0,
          locked_until: null,
        },
        { onConflict: 'email' }
      );
    if (upsertErr) throw upsertErr;

    try {
      await sendEmail(
        normalizedEmail,
        'Verify your RentaPay email',
        wrapEmailHtml(`Your RentaPay verification code is: ${otp}\n\nThis code expires in 10 minutes. Enter it on the signup page to verify your email.`)
      );
    } catch (emailErr) {
      logger.error('[auth] requestLandlordEmailVerification: failed to send:', emailErr.message);
      captureException(emailErr);
      return res.status(502).json({ error: 'Could not send the verification email. Please check the address and try again.' });
    }

    return res.json({ message: 'Verification code sent to your email.' });
  } catch (err) {
    logger.error('[auth] requestLandlordEmailVerification error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to send verification code.' });
  }
}

// PUBLIC - step 2: confirm the code. Returns a short-lived opaque
// token (NOT the OTP itself) the frontend must send back on
// registerLandlord - proves this exact email was confirmed in this
// same flow.
async function confirmLandlordEmailVerification(req, res) {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and code are required.' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const { data: record, error: recordErr } = await supabase
      .from('landlord_registration_email_otps')
      .select('*')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (recordErr) throw recordErr;
    if (!record) return res.status(400).json({ error: 'Request a verification code for this email first.' });

    if (record.locked_until && new Date(record.locked_until) > new Date()) {
      return res.status(423).json({ error: `Too many incorrect codes. Try again after ${record.locked_until}, or request a new code.` });
    }
    if (isOTPExpired(record.expires_at)) {
      return res.status(400).json({ error: 'That code has expired. Request a new one.' });
    }
    if (record.otp_code !== String(otp).trim()) {
      const failedAttempts = (record.failed_attempts || 0) + 1;
      const update = { failed_attempts: failedAttempts };
      if (failedAttempts >= 5) {
        const lockUntil = new Date();
        lockUntil.setMinutes(lockUntil.getMinutes() + 15);
        update.locked_until = lockUntil.toISOString();
      }
      await supabase.from('landlord_registration_email_otps').update(update).eq('id', record.id);
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }

    const verificationToken = crypto.randomBytes(24).toString('hex');
    await supabase
      .from('landlord_registration_email_otps')
      .update({ verified: true, verification_token: verificationToken, failed_attempts: 0, locked_until: null })
      .eq('id', record.id);

    return res.json({ verified: true, emailVerification: verificationToken });
  } catch (err) {
    logger.error('[auth] confirmLandlordEmailVerification error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to verify code.' });
  }
}

async function registerLandlord(req, res) {
  let insertedLandlordId = null; // tracked so we can roll back on failure

  try {
    let { fullName, phone, email, password, gender, unitsCount, periodMonths, whatsappNumber, refCode, emailVerification } = req.body;

    // DIRECT REQUEST: email is now mandatory during setup - it's the
    // only channel OTPs, password resets, and every other account
    // notification go out on now that WhatsApp is disabled (see
    // notify.service.js / sms.service.js). Phone is still collected
    // and used for login + M-Pesa STK, but email is where messages land.
    if (!fullName || !phone || !email || !password || !unitsCount || !periodMonths || !whatsappNumber) {
      return res.status(400).json({ error: 'fullName, phone, email, password, unitsCount, periodMonths, and whatsappNumber are required.' });
    }
    email = email.trim();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // DIRECT REQUEST: the landlord must verify their email on the SAME
    // page as their details, before continuing to payment - just like
    // a tenant confirms on the same page before submitting via the
    // onboarding link. So by the time this endpoint is called, the
    // email must already have been confirmed via
    // requestLandlordEmailVerification / confirmLandlordEmailVerification
    // above, for this EXACT address, and the frontend must echo back
    // the token that proved it - same pattern as submitBaOnboarding's
    // emailVerification check.
    const normalizedEmail = email.toLowerCase();
    if (!emailVerification) {
      return res.status(400).json({ error: 'Please verify your email address before submitting.', emailNotVerified: true });
    }
    const { data: emailOtpRecord, error: emailOtpErr } = await supabase
      .from('landlord_registration_email_otps')
      .select('verified, verification_token')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (emailOtpErr) throw emailOtpErr;
    if (!emailOtpRecord?.verified || emailOtpRecord.verification_token !== emailVerification) {
      return res.status(400).json({ error: 'Please verify your email address before submitting.', emailNotVerified: true });
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
    try {
      whatsappNumber = normalizePhoneOrThrow(whatsappNumber, 'WhatsApp number');
    } catch (waErr) {
      return res.status(400).json({ error: waErr.message });
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
        logger.warn(`[auth] Removed stale pending registration for phone ${phone} (id ${existing.id}) to allow retry.`);
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
    //
    // BUG FIX (direct request: "a landlord just logged in using a BA
    // already used email and it went through"): this used to only
    // query the landlords table, same as the phone check used to
    // before findPhoneConflict was introduced above. That meant an
    // email already used by a brand ambassador (or a manager/
    // caretaker, or an active tenant) was never caught here, letting
    // the same email register a second, unrelated account under a
    // different role. Every other registration path (tenant, manager,
    // BA) already goes through findEmailConflict - landlord signup was
    // the one gap. Now email is enforced as globally unique across
    // every role, exactly like phone.
    if (email) {
      const conflictEmail = await findEmailConflict(email, 'landlord');
      if (conflictEmail) return res.status(409).json({ error: conflictEmail });
    }

    // No landlordId yet - this is a brand-new signup, so there's no
    // loyalty discount to look up.
    const { totalCost } = await calculateSubscriptionCost(Number(unitsCount), Number(periodMonths));
    const passwordHash = await hashPassword(password);

    // PHASE 4 (BA referral-link signup): if a ?ref=BA-XXXX code rode
    // along with this registration, tag the new landlord with that
    // BA's id at creation time - this is the ONLY way a landlord ever
    // gets attached to a BA (Section A of the consolidated change
    // instructions - manual claim logging/fallback has been removed
    // entirely). Fails SILENTLY on a bad/expired/inactive code - per
    // the spec, a typo'd ref code must never block or error out the
    // landlord's own registration.
    let referredByBaId = null;
    if (refCode && typeof refCode === 'string' && refCode.trim()) {
      try {
        const { data: referringBa } = await supabase
          .from('brand_ambassadors')
          .select('id, status')
          .eq('referral_code', refCode.trim())
          .maybeSingle();
        if (referringBa && referringBa.status === 'active') {
          referredByBaId = referringBa.id;
        }
      } catch (refLookupErr) {
        // Non-fatal by design - see comment above.
        logger.warn('[auth] registerLandlord: referral code lookup failed (non-fatal):', refLookupErr.message);
      }
    }

    const { data: landlord, error } = await supabase
      .from('landlords')
      .insert({
        full_name: fullName,
        phone,
        email: email || null,
        gender: gender || null,
        whatsapp_number: whatsappNumber,
        password_hash: passwordHash,
        subscription_period_months: periodMonths,
        unit_limit: unitsCount,
        subscription_status: 'pending',
        ba_id: referredByBaId,
        // Email was already confirmed on the details page, before this
        // account row ever existed (see the emailVerification check
        // above) - so there's nothing left for a later OTP step to
        // prove after the fact.
        email_verified: true,
      })
      .select()
      .single();

    if (error) throw error;
    insertedLandlordId = landlord.id;

    // SECTION C: no separate claim/event row to log anymore. The
    // daily BA-qualification cron job (src/jobs/baQualification.job.js)
    // now scans `landlords` directly (ba_id is not null AND
    // ba_qualification_status = 'pending') - landlords.ba_id, set
    // above, is all it needs to pick this signup up on its next run.

    // PHASE 9 - marketing self-fill lead auto-conversion: if this
    // phone matches a still-open landlord_leads row, mark it
    // converted now that a real account exists. Best-effort/non-
    // fatal, same as the referral-code lookup above - see
    // landlordLead.controller.js for details.
    await convertMatchingLeadForPhone(phone, landlord.id);

    // DIRECT REQUEST (reordered flow): registration no longer creates
    // its own email OTP here - verification already happened on the
    // details page before submission (see emailVerification check
    // above). The landlord goes straight from "Your details" to the
    // Payment step now, with no separate "Verify email" step/page in
    // between.
    logActivity({
      actorType: 'system',
      action: 'landlord_registration_initiated',
      targetType: 'landlord',
      targetId: landlord.id,
      metadata: { totalCost, unitsCount, periodMonths },
    });

    return res.status(201).json({
      message: 'Registration saved. Continue to payment.',
      landlordId: landlord.id,
      amountDue: totalCost,
    });
  } catch (err) {
    // Belt-and-suspenders: if something else entirely throws after the
    // insert succeeded (e.g. logActivity throwing - it shouldn't, see
    // activityLog.service.js, but just in case), still clean up rather
    // than leave an orphan.
    if (insertedLandlordId) {
      await supabase.from('landlords').delete().eq('id', insertedLandlordId).then(
        () => logger.warn(`[auth] Rolled back orphaned landlord ${insertedLandlordId} after unexpected error.`),
        () => {}
      );
    }
    logger.error('[auth] registerLandlord error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Something went wrong while creating your account. Please try again in a moment.' });
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
async function activateLandlordAfterPayment(landlordId, periodMonths, unitsCount, amountPaid, subscriptionPaymentId) {
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

  // Phase 13 - true MRR: this landlord's very first coverage period,
  // starting today. unitsCount/amountPaid are optional (older/other
  // call sites that haven't been updated to pass them through yet)
  // so this never throws and blocks account activation itself over a
  // missing analytics input - it just skips the coverage-period
  // record in that case, same as any other coveragePeriod.service.js
  // failure (see that file's own try/catch).
  if (unitsCount && amountPaid != null) {
    await createCoveragePeriod({
      landlordId,
      kind: 'first',
      startDate: startedAt,
      endDate: expiresAt,
      unitsCovered: unitsCount,
      amountPaid,
      periodMonths: months,
      subscriptionPaymentId,
    });
  }

  return landlord;
}

// ---------------------------------------------------------------------
// LANDLORD EMAIL VERIFICATION (direct request - separate from the
// payment-gated is_verified flow above; see
// 2026-07-landlord-email-verification.sql for why these are distinct
// columns rather than reusing otp_code/otp_expires_at/is_verified).
// ---------------------------------------------------------------------
const EMAIL_OTP_MAX_ATTEMPTS = 5;
const EMAIL_OTP_LOCKOUT_MINUTES = 15;

async function verifyLandlordEmailOTP(req, res) {
  try {
    const { landlordId, otp } = req.body;
    if (!landlordId || !otp) return res.status(400).json({ error: 'landlordId and otp are required.' });

    const { data: landlord, error } = await supabase.from('landlords').select('*').eq('id', landlordId).maybeSingle();
    if (error || !landlord) return res.status(404).json({ error: 'Account not found.' });

    if (landlord.email_verified) {
      return res.json({ message: 'Email already verified.', emailVerified: true });
    }

    if (landlord.email_otp_locked_until && new Date(landlord.email_otp_locked_until) > new Date()) {
      return res.status(423).json({ error: `Too many incorrect codes. Try again after ${landlord.email_otp_locked_until}, or request a new code.` });
    }

    if (!landlord.email_otp_code || landlord.email_otp_code !== otp) {
      const newAttempts = (landlord.email_otp_failed_attempts || 0) + 1;
      const updateFields = { email_otp_failed_attempts: newAttempts };
      if (newAttempts >= EMAIL_OTP_MAX_ATTEMPTS) {
        const lockUntil = new Date();
        lockUntil.setMinutes(lockUntil.getMinutes() + EMAIL_OTP_LOCKOUT_MINUTES);
        updateFields.email_otp_locked_until = lockUntil.toISOString();
      }
      await supabase.from('landlords').update(updateFields).eq('id', landlordId);
      return res.status(400).json({ error: 'Invalid code.' });
    }

    if (isOTPExpired(landlord.email_otp_expires_at)) {
      return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    }

    const { error: updateError } = await supabase
      .from('landlords')
      .update({
        email_verified: true,
        email_otp_code: null,
        email_otp_expires_at: null,
        email_otp_failed_attempts: 0,
        email_otp_locked_until: null,
      })
      .eq('id', landlordId);
    if (updateError) throw updateError;

    clearResendAttempts('landlord-email-otp', landlordId);
    return res.json({ message: 'Email verified successfully.', emailVerified: true });
  } catch (err) {
    logger.error('[auth] verifyLandlordEmailOTP error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to verify email.' });
  }
}

async function resendLandlordEmailOTP(req, res) {
  try {
    const { landlordId } = req.body;
    if (!landlordId) return res.status(400).json({ error: 'landlordId is required.' });

    const { data: landlord, error } = await supabase.from('landlords').select('id, full_name, email, email_verified').eq('id', landlordId).maybeSingle();
    if (error || !landlord) return res.status(404).json({ error: 'Account not found.' });
    if (!landlord.email) return res.status(400).json({ error: 'No email on file for this account.' });
    if (landlord.email_verified) return res.json({ message: 'Email already verified.', emailVerified: true });

    const rateCheck = checkAndRecordResend('landlord-email-otp', landlordId);
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: `Too many attempts. Please try again in ${rateCheck.retryAfterMinutes} minute(s).` });
    }

    const emailOtp = generateOTP();
    const emailOtpExpiresAt = getOTPExpiry();
    await supabase
      .from('landlords')
      .update({ email_otp_code: emailOtp, email_otp_expires_at: emailOtpExpiresAt.toISOString(), email_otp_failed_attempts: 0, email_otp_locked_until: null })
      .eq('id', landlordId);
    await sendEmail(
      landlord.email,
      'Your RentaPay verification code',
      wrapEmailHtml(`Hi ${landlord.full_name},\n\nYour RentaPay email verification code is: ${emailOtp}\n\nThis code expires in 24 hours.`)
    );

    return res.json({ message: 'A new code has been sent to your email.' });
  } catch (err) {
    logger.error('[auth] resendLandlordEmailOTP error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to resend code.' });
  }
}

// DIRECT REQUEST (reordered signup flow): payment is no longer started
// as a side effect of registerLandlord. It now only starts once a
// landlord has verified their email and landed on the dedicated
// Payment step, which calls this endpoint. Re-checking email_verified
// server-side (not just trusting the frontend's step order) means the
// gate holds even against a replayed/forged request straight to this
// route.
async function initiateLandlordSubscriptionPayment(req, res) {
  try {
    const { landlordId } = req.body;
    if (!landlordId) return res.status(400).json({ error: 'landlordId is required.' });

    const { data: landlord, error } = await supabase.from('landlords').select('*').eq('id', landlordId).maybeSingle();
    if (error || !landlord) return res.status(404).json({ error: 'Account not found.' });

    if (!landlord.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before proceeding to payment.' });
    }

    if (landlord.subscription_status !== 'pending') {
      // Already activated (e.g. a duplicate/retried call) - nothing to
      // charge again for.
      return res.json({ message: 'Account already active.', checkoutRequestId: null, amountDue: 0, stkFailed: false });
    }

    const unitsCount = landlord.unit_limit;
    const periodMonths = landlord.subscription_period_months;
    const { totalCost } = await calculateSubscriptionCost(Number(unitsCount), Number(periodMonths), landlordId);

    // Same "never hard-fail on a Daraja hiccup" behaviour this used to
    // have inline in registerLandlord - an STK failure falls back to
    // the manual-payment form already on the frontend's Payment step
    // instead of blocking the landlord entirely.
    let stkResponse = null;
    let stkFailureReason = null;
    try {
      stkResponse = await initiateSTKPush({
        phoneNumber: landlord.phone,
        amount: totalCost,
        accountReference: `RENTAPAY-${landlord.id.slice(0, 8)}`,
        transactionDesc: 'RentaPay subscription',
      });
    } catch (stkErr) {
      logger.error('[auth] STK push failed at payment step - falling back to manual payment:', stkErr.message);
      captureException(stkErr);
      stkFailureReason = stkErr.message;
    }

    // Without this insert, the Daraja callback has nothing to match the
    // incoming CheckoutRequestID against (see the equivalent note that
    // used to live in registerLandlord) - only relevant when the STK
    // push actually went through.
    if (stkResponse) {
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
        logger.error(
          '[auth] CRITICAL: STK push succeeded but failed to record subscription_payments row:',
          subPaymentError.message,
          '- checkoutRequestId:', stkResponse.CheckoutRequestID,
          '- landlordId:', landlord.id
        );
        captureException(subPaymentError);
      }
    }

    return res.json({
      message: stkResponse
        ? 'Complete the M-Pesa prompt sent to your phone to activate your account.'
        : "We couldn't send the automatic M-Pesa prompt right now - pay manually below and your account will be activated once verified.",
      amountDue: totalCost,
      checkoutRequestId: stkResponse ? stkResponse.CheckoutRequestID : null,
      stkFailed: !stkResponse,
      stkFailureReason: stkResponse ? undefined : stkFailureReason,
    });
  } catch (err) {
    logger.error('[auth] initiateLandlordSubscriptionPayment error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to start payment.' });
  }
}

// DIRECT REQUEST: "provide a way to go back and correct the email" on
// the Verify-your-email step - a landlord who mistyped their email at
// signup was previously stuck (nothing pre-login lets them change it,
// and resend just resends to the same wrong address). Only usable
// before verification - once verified, changing it is a Settings/
// account-management concern, not a signup-flow one.
async function updateLandlordRegistrationEmail(req, res) {
  try {
    const { landlordId, email } = req.body;
    if (!landlordId || !email) return res.status(400).json({ error: 'landlordId and email are required.' });

    const trimmedEmail = email.trim();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const { data: landlord, error } = await supabase.from('landlords').select('id, full_name, email, email_verified').eq('id', landlordId).maybeSingle();
    if (error || !landlord) return res.status(404).json({ error: 'Account not found.' });

    if (landlord.email_verified) {
      return res.status(400).json({ error: 'Email is already verified and can no longer be changed here.' });
    }

    if (trimmedEmail !== landlord.email) {
      // Same cross-role gap as registerLandlord above - a BA/manager/
      // tenant email must be blocked here too, not just another
      // landlord's email.
      const conflictEmail = await findEmailConflict(trimmedEmail, 'landlord');
      if (conflictEmail) return res.status(409).json({ error: conflictEmail });
    }

    const emailOtp = generateOTP();
    const emailOtpExpiresAt = getOTPExpiry();
    const { error: updateError } = await supabase
      .from('landlords')
      .update({
        email: trimmedEmail,
        email_otp_code: emailOtp,
        email_otp_expires_at: emailOtpExpiresAt.toISOString(),
        email_otp_failed_attempts: 0,
        email_otp_locked_until: null,
      })
      .eq('id', landlordId);
    if (updateError) throw updateError;

    await sendEmail(
      trimmedEmail,
      'Verify your RentaPay email',
      wrapEmailHtml(`Hi ${landlord.full_name},\n\nYour RentaPay email verification code is: ${emailOtp}\n\nThis code expires in 24 hours.`)
    );

    return res.json({ message: 'Email updated. A new code has been sent.', email: trimmedEmail });
  } catch (err) {
    logger.error('[auth] updateLandlordRegistrationEmail error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update email.' });
  }
}


// ---------------------------------------------------------------------
// OTP VERIFICATION (shared shape for landlord/tenant)
// ---------------------------------------------------------------------
async function verifyOTP(req, res) {
  try {
    const { accountType, accountId, otp } = req.body; // accountType: 'landlord' | 'tenant' | 'manager'

    if (!ALL_ACCOUNT_TYPES.includes(accountType)) {
      return res.status(400).json({ error: "accountType must be 'landlord', 'tenant', or 'manager'." });
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

    // SECURITY FIX: OTP verification previously had no brute-force
    // protection at all - unlike login (which already locks out after
    // repeated failures), someone could script-guess a 6-digit OTP
    // against this endpoint with no limit. Same lockout shape as
    // login, tracked in separate otp_* columns since this is a
    // different risk window (right after signup, before the account
    // is verified) and shouldn't share a counter with login attempts.
    if (account.otp_locked_until && new Date(account.otp_locked_until) > new Date()) {
      return res.status(423).json({ error: `Too many incorrect codes. Try again after ${account.otp_locked_until}, or request a new OTP.` });
    }

    if (!account.otp_code || account.otp_code !== otp) {
      const newAttempts = (account.otp_failed_attempts || 0) + 1;
      const updateFields = { otp_failed_attempts: newAttempts };
      if (newAttempts >= OTP_MAX_ATTEMPTS) {
        const lockUntil = new Date();
        lockUntil.setMinutes(lockUntil.getMinutes() + OTP_LOCKOUT_MINUTES);
        updateFields.otp_locked_until = lockUntil.toISOString();
      }
      await supabase.from(table).update(updateFields).eq('id', accountId);
      return res.status(400).json({ error: 'Invalid OTP.' });
    }

    if (isOTPExpired(account.otp_expires_at)) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    const updateFields = { is_verified: true, otp_code: null, otp_expires_at: null, otp_failed_attempts: 0, otp_locked_until: null };
    const { error: updateError } = await supabase.from(table).update(updateFields).eq('id', accountId);

    if (updateError) throw updateError;

    const { phoneField } = accountTable(accountType);
    clearResendAttempts('otp', `${accountType}:${account[phoneField]}`);

    // DIRECT REQUEST FIX ("after verifying, log the person straight
    // in - don't make them re-enter credentials"): verifyOTP already
    // proved this person controls the account (they typed a code that
    // only the account owner could have received by email), which is
    // exactly the same trust bar login() clears with a password. So
    // issue a real session token here too, same shape login() hands
    // back, instead of just a bare success message that sends them
    // back to a blank login form.
    const token = signToken(
      accountType === 'manager'
        ? { id: account.id, role: accountType, landlordId: account.landlord_id, roleLevel: account.role_level || 'manager' }
        : { id: account.id, role: accountType }
    );

    return res.json({
      message: 'Account verified successfully.',
      token,
      role: accountType,
      roleLevel: accountType === 'manager' ? account.role_level || 'manager' : undefined,
      mustChangePassword: account.must_change_password || false,
      phone: account[phoneField],
    });
  } catch (err) {
    logger.error('[auth] verifyOTP error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to verify OTP.' });
  }
}

// ---------------------------------------------------------------------
// LOGIN (landlord or tenant) — shared logic, with lockout per blueprint 14.2
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// PHASE 3 - BA PORTAL: LOGIN
//
// Same single login form/endpoint everyone else uses - no separate BA
// login page. brand_ambassadors is intentionally kept OUT of
// ALL_ACCOUNT_TYPES/accountTable's generic is_active-filtered lookups
// (see the call site in login() above) because this table uses a
// `status` enum instead of is_active, and has no failed_login_attempts/
// locked_until lockout columns the way the other four tables do - so
// this is a small, self-contained handler rather than forcing BA into
// logic shaped around assumptions that don't hold for it.
//
// Returns null when there's no brand_ambassadors row for this email at
// all (so the caller falls through to the normal generic "invalid
// credentials" response and never reveals whether a BA account exists).
// Returns { status, body } for every other outcome - suspended/
// inactive/rejected/pending, wrong password, or a real success.
// ---------------------------------------------------------------------
async function handleBrandAmbassadorLogin({ email, password, invalidCredsMsg }) {
  const { data: ba, error } = await supabase
    .from('brand_ambassadors')
    .select('*')
    .ilike('email', email)
    .maybeSingle();

  if (error || !ba) return null;

  // Applications that never got approved have no password_hash yet -
  // there's nothing to compare against, so this is reported the same
  // way as a wrong password rather than a confusing 500.
  if (!ba.password_hash) {
    return { status: 401, body: { error: invalidCredsMsg } };
  }

  const passwordMatches = await comparePassword(password, ba.password_hash);
  if (!passwordMatches) {
    return { status: 401, body: { error: invalidCredsMsg } };
  }

  // Status gate, checked AFTER the password is confirmed correct (same
  // ordering rule as moderationSuspensionError above) - matches Phase
  // 16's distinction between 'suspended' (reversible, blocks login) and
  // 'inactive' (permanent offboarding), and blocks the two states that
  // should never have reached this table with a usable session at all.
  if (ba.status === 'pending_approval') {
    return { status: 403, body: { error: 'Your Brand Ambassador application is still pending admin approval.', baPendingApproval: true } };
  }
  if (ba.status === 'rejected') {
    return { status: 401, body: { error: invalidCredsMsg } };
  }
  if (ba.status === 'suspended') {
    return { status: 403, body: { error: 'Your account has been suspended. Contact RentaPay support for more information.', suspended: true } };
  }
  if (ba.status === 'inactive') {
    return { status: 403, body: { error: 'This account is no longer active.', accountInactive: true } };
  }
  // ba.status === 'active' from here down.

  const token = signToken({ id: ba.id, role: 'brand_ambassador' });

  logActivity({ actorType: 'brand_ambassador', actorId: ba.id, action: 'login', targetType: 'brand_ambassador', targetId: ba.id });

  return {
    status: 200,
    body: {
      token,
      // Reuses the exact same field name/flow the frontend already
      // knows how to handle for tenants/managers on first login.
      mustChangePassword: ba.must_change_password || false,
      role: 'brand_ambassador',
      phone: ba.phone,
      baCode: ba.ba_code,
      referralCode: ba.referral_code,
    },
  };
}

// ---------------------------------------------------------------------
// SECTION 3 — General Manager: Dedicated Login Entry Point
//
// Deliberately its OWN endpoint, not folded into the unified login()
// below - the spec calls for a login screen General Managers reach
// only via their own dedicated URL (rentapay.co.ke/manager-account,
// see App.jsx), separate from the landlord/manager/tenant screen at
// /login and from the hidden admin screen. Modeled closely on
// handleBrandAmbassadorLogin (self-contained, own table, own status
// rules) rather than on accountTable()'s generic multi-role lookups,
// since - like brand_ambassadors - general_managers is never part of
// ALL_ACCOUNT_TYPES/login()'s auto-detect matching; it only ever gets
// reached through this one dedicated route.
// ---------------------------------------------------------------------
async function generalManagerLogin(req, res) {
  try {
    let { email, password } = req.body;
    if (typeof email === 'string') email = email.trim();

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    // Same lockdown gate every non-admin login path respects.
    const { data: settings } = await supabase
      .from('platform_settings')
      .select('is_locked_down, lockdown_reason')
      .eq('id', 1)
      .maybeSingle();
    if (settings?.is_locked_down) {
      return res.status(503).json({ error: settings.lockdown_reason || 'The platform is temporarily paused for technical maintenance.', lockedDown: true });
    }

    const invalidCredsMsg = 'Invalid email or password.';

    const { data: manager, error } = await supabase
      .from('general_managers')
      .select('*')
      .ilike('email', email)
      .maybeSingle();

    // Never reveal whether the email is registered - identical
    // response to a wrong password on a real account.
    if (error || !manager) {
      return res.status(401).json({ error: invalidCredsMsg });
    }

    const passwordMatches = await comparePassword(password, manager.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: invalidCredsMsg });
    }

    // A submission via the self-service onboarding link sits as
    // 'pending_approval' (no password set yet) until admin reviews
    // it - see submitGmOnboarding / approveGmApplication. Give that
    // case its own message rather than the generic "suspended" one.
    if (manager.status === 'pending_approval') {
      return res.status(403).json({ error: 'Your application is still pending admin review. You will receive your login details by email once approved.', applicationPending: true });
    }
    if (manager.status === 'rejected') {
      return res.status(403).json({ error: 'Your application was not approved. Contact RentaPay support for more information.', applicationRejected: true });
    }
    if (!manager.is_active) {
      return res.status(403).json({ error: 'Your access has been removed. Contact RentaPay support for more information.', accountSuspended: true });
    }

    const token = signToken({ id: manager.id, role: 'general_manager' });

    logActivity({
      actorType: 'general_manager',
      actorId: manager.id,
      action: 'general_manager_login',
      targetType: 'general_manager',
      targetId: manager.id,
      ipAddress: req.ip,
    });

    return res.json({
      token,
      role: 'general_manager',
      fullName: manager.full_name,
      email: manager.email,
      // Frontend routes to the forced password-change screen first
      // (same field name/flow as every other role), then - once
      // that's done - to Operations PIN setup, per Section 4.
      mustChangePassword: manager.must_change_password || false,
      operationsPinSet: !!manager.operations_pin_hash,
      // FEATURE (direct request) - per-manager toggles set by admin;
      // the frontend uses these to decide whether to render the
      // Loyalty Discounts edit controls / show the Landlord Manual
      // Payments menu item at all for this GM.
      canGrantLoyaltyDiscounts: !!manager.can_grant_loyalty_discounts,
      canManageManualPayments: !!manager.can_manage_manual_payments,
      photoUrl: manager.photo_url || null,
    });
  } catch (err) {
    logger.error('[auth] generalManagerLogin error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to log in.' });
  }
}

async function login(req, res) {
  try {
    const { password } = req.body;
    let { phone, email, accountType } = req.body;
    // Defensive trim: storage is now always trimmed (see addTenant/
    // addManager/registerLandlord/updateMyContact), but a stray space
    // typed or auto-filled here on login should never turn a correct
    // email into a false "invalid credentials".
    if (typeof email === 'string') email = email.trim();

    // DIRECT REQUEST: phone-number login removed entirely for every
    // role except admin (admin uses the separate adminLogin() below,
    // untouched by this) - login is email-only now. `phone` is still
    // accepted as an incoming field for backward compatibility with
    // any stale client build, but it's ignored for lookup purposes;
    // only `email` is ever used to find the account. See
    // 2026-07-normalize-existing-phone-numbers.sql for the reason
    // phone login used to fail for some accounts in the first place -
    // that's now moot for login itself, though phone is still used
    // elsewhere (M-Pesa STK, WhatsApp contact links, reminders).
    void phone;
    const usingEmail = true;

    if (!email) {
      return res.status(400).json({ error: 'email and password are required.' });
    }
    if (!password) {
      return res.status(400).json({ error: 'email and password are required.' });
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
      return res.status(400).json({ error: "accountType, if provided, must be 'landlord', 'manager', or 'tenant'." });
    }

    // Generic invalid-credentials message so a failed login never
    // reveals whether the email is registered.
    const invalidCredsMsg = 'Invalid email or password.';

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
      let lookupQuery = usingEmail
        ? supabase.from(table).select('*').ilike('email', email)
        : supabase.from(table).select('*').eq(phoneField, phone);
      if (accountType !== 'landlord') lookupQuery = lookupQuery.eq('is_active', true);
      const [{ data: settings }, { data: acc, error }] = await Promise.all([settingsPromise, lookupQuery.maybeSingle()]);
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
        // PHASE 3 (BA portal): brand_ambassadors isn't part of
        // ALL_ACCOUNT_TYPES/findAccountsByEmail (that table has no
        // is_active column - it uses `status` instead - and folding it
        // into the generic multi-role lookup above would misapply the
        // `is_active` filter used for every other non-landlord type).
        // Checked as a distinct fallback instead, only when nothing in
        // the generic tables matched, so existing landlord/manager/
        // tenant/admin behavior above is completely untouched.
        const baResult = await handleBrandAmbassadorLogin({ email, password, invalidCredsMsg });
        if (baResult) return res.status(baResult.status).json(baResult.body);

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
        // Dual-role case (e.g. a landlord who is also a property
        // manager on the side): check the password against every
        // matched account, and only ever mention the ones it actually
        // unlocks - a person who only knows one of the two passwords
        // should never learn that a second account on this number
        // exists at all.
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
      // Structured `lockedUntil` (ISO) alongside the message so the
      // frontend can render a plain-language, live-ticking countdown
      // instead of parsing/displaying the raw timestamp itself.
      return res.status(423).json({
        error: 'Account temporarily locked due to repeated failed attempts.',
        lockedUntil: account.locked_until,
      });
    }

    const modSuspension = moderationSuspensionError(account);
    if (modSuspension) return res.status(modSuspension.status).json(modSuspension.body);

    if (accountType === 'tenant' && account.landlord_id) {
      const tenantUnavailable = await tenantSubscriptionUnavailableError(account.landlord_id);
      if (tenantUnavailable) return res.status(tenantUnavailable.status).json(tenantUnavailable.body);
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
        .then(({ error: resetErr }) => { if (resetErr) { logger.error('[auth] login: failed to reset attempt counter (non-fatal):', resetErr.message); captureException(resetErr); } });

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
          amountDue = (await calculateSubscriptionCost(account.unit_limit, account.subscription_period_months, account.id)).totalCost;
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
      logger.info('[auth][DEBUG_AUTH] ----------------------------------------');
      logger.info('[auth][DEBUG_AUTH] Query returned account:', { id: account.id, phone: account[phoneField], is_verified: account.is_verified });
      logger.info('[auth][DEBUG_AUTH] password_hash length:', hash.length, '| starts with:', hash.slice(0, 7) + '...');
      logger.info('[auth][DEBUG_AUTH] Looks like a real bcrypt hash ($2a/$2b/$2y$ + cost):', looksLikeBcrypt);
      if (!looksLikeBcrypt) {
        logger.info(
          '[auth][DEBUG_AUTH] *** This is almost certainly your bug. ***',
          'password_hash does not match bcrypt\'s format. If you inserted',
          'a plaintext password directly into Supabase, bcrypt.compare()',
          'will ALWAYS return false against it, regardless of what the',
          'user types. Run it through hashPassword() first - see the',
          'normalization steps in the chat response.'
        );
      }
      logger.info('[auth][DEBUG_AUTH] Submitted password length:', (password || '').length, '(value masked)');
      logger.info('[auth][DEBUG_AUTH] ----------------------------------------');
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

      // Structured, queryable failed-login record - e.g. filter logs on
      // accountType=landlord + accountId=X to see every failed attempt
      // against a specific landlord over any time range, rather than
      // grepping for a phone number in free text.
      logger.warn('[auth] login failed - incorrect password', {
        accountType,
        accountId: account.id,
        attemptNumber: newAttempts,
        lockedOut: !!updateFields.locked_until,
      });

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
          logger.warn(`[auth] login: cannot send OTP - no email on file for ${accountType} ${account.id}`);
        }
      }

      await supabase.from(table).update({ failed_login_attempts: 0, locked_until: null }).eq('id', account.id);

      return res.status(200).json({
        needsVerification: true,
        accountType,
        accountId: account.id,
        phone,
        email: account.email || null,
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
      .then(({ error: resetErr }) => { if (resetErr) { logger.error('[auth] login: failed to reset attempt counter (non-fatal):', resetErr.message); captureException(resetErr); } });

    const token = signToken(
      accountType === 'manager'
        ? { id: account.id, role: accountType, landlordId: account.landlord_id, roleLevel: account.role_level || 'manager' }
        : { id: account.id, role: accountType }
    );

    const resume = accountType === 'landlord' ? await computeLandlordResumeStep(account) : null;

    return res.json({
      token,
      mustChangePassword: account.must_change_password || false,
      setupWizardComplete: accountType === 'landlord' ? account.setup_wizard_complete : undefined,
      setupWizardStep: resume?.step,
      setupWizardPropertyId: resume?.defaultPropertyId,
      role: accountType,
      roleLevel: accountType === 'manager' ? account.role_level || 'manager' : undefined,
      subscriptionExpired,
      // Always the account's real phone number, regardless of whether
      // the person signed in with it or with their email - the
      // frontend needs this for its own session state either way.
      phone: account[phoneField],
    });
  } catch (err) {
    logger.error('[auth] login error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to log in.' });
  }
}

// ---------------------------------------------------------------------
// GOOGLE LOGIN (item 2 of the requested feature set)
//
// Deliberately login-only, not registration. RentaPay accounts aren't
// created here: a landlord account requires the subscription payment
// wizard (registerLandlord), and tenant/manager accounts are created
// BY a landlord (see tenant.controller.js / propertyManager.controller.js).
// A brand-new person clicking "Continue with Google" with no existing
// RentaPay account gets told to sign up (landlord) or contact their
// landlord (tenant/manager) instead of silently creating an account -
// same shape every other unmatched-credential path in this file takes.
//
// Frontend sends the raw Google ID token (a signed JWT straight from
// Google's own sign-in button/prompt) - never a plain email string,
// which anyone could type in and claim to own. verifyIdToken() below
// is what actually proves it: Google's library checks the token's
// cryptographic signature against Google's own public keys and that
// the `aud` claim matches GOOGLE_CLIENT_ID, so this can't be spoofed
// by just POSTing an arbitrary email/JWT-shaped string.
// ---------------------------------------------------------------------
// FIX (direct request: "the platform logs in using email only... so
// the message is misleading"): login() above was changed to be
// email-only (phone-number login was removed for every role except
// admin), but this fallback message was never updated to match - it
// still told people to "log in with phone/email" and to try "your
// phone number" as an alternative identifier, both of which no
// longer do anything on the login form.
const GOOGLE_NO_ACCOUNT_MSG =
  "No RentaPay account is registered with this Google email. If your account uses a different email, log in with your email below instead - or sign up as a landlord, or ask your landlord to add you with this email address.";

async function loginWithGoogle(req, res) {
  try {
    const { idToken } = req.body;
    let { accountType } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required.' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      logger.error('[auth] loginWithGoogle: GOOGLE_CLIENT_ID is not set in the environment.');
      return res.status(503).json({ error: 'Google sign-in is temporarily unavailable. Please log in with your email and password instead.' });
    }
    if (accountType && !ALL_ACCOUNT_TYPES.includes(accountType)) {
      return res.status(400).json({ error: "accountType, if provided, must be 'landlord', 'manager', or 'tenant'." });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (err) {
      logger.error('[auth] loginWithGoogle: token verification failed:', err.message);
      captureException(err);
      return res.status(401).json({ error: 'Could not verify your Google sign-in. Please try again.' });
    }

    const email = (payload?.email || '').trim();
    if (!email) {
      return res.status(401).json({ error: 'Your Google account has no email address to sign in with.' });
    }
    // Google itself refuses to issue a token for an unverified email in
    // the vast majority of cases, but this is a cheap, explicit check
    // rather than trusting that silently.
    if (payload.email_verified === false) {
      return res.status(401).json({ error: 'Your Google email address is not verified. Please verify it with Google first.' });
    }

    // Same lockdown check every other login path runs, before touching
    // any account data.
    const { data: settings } = await supabase
      .from('platform_settings')
      .select('is_locked_down, lockdown_reason')
      .eq('id', 1)
      .maybeSingle();
    if (settings?.is_locked_down) {
      return res.status(503).json({
        error: settings.lockdown_reason || 'The platform is temporarily paused for technical maintenance.',
        lockedDown: true,
      });
    }

    let table, phoneField, account;

    if (accountType) {
      // Re-submit after the dual-role picker below.
      ({ table, phoneField } = accountTable(accountType));
      // ARCHIVE FIX (same as findAccountsByEmail/findAccountsByPhone
      // above): without scoping to is_active, an archived manager/
      // tenant row left behind with the same email as a newly
      // re-added active one makes maybeSingle() see two rows and
      // error out - silently returning "account not found" here
      // even though a real, active account with this email exists.
      // That's the exact "flagged as incorrect, stuck" symptom for a
      // tenant/manager/caretaker re-added under a new landlord after
      // being archived elsewhere.
      let lookupQuery = supabase.from(table).select('*').ilike('email', email);
      if (accountType !== 'landlord') lookupQuery = lookupQuery.eq('is_active', true);
      let { data: acc } = await lookupQuery.maybeSingle();
      if (!acc) {
        // Gmail-alias fallback (see findAccountsByEmailFlexible) so a
        // dotted/plus-aliased variant of the same mailbox still finds
        // this account on the re-submit path too.
        const flexible = await findAccountsByEmailFlexible(email);
        acc = flexible.find((m) => m.accountType === accountType)?.account || null;
      }
      if (!acc) {
        return res.status(404).json({ error: GOOGLE_NO_ACCOUNT_MSG });
      }
      account = acc;
    } else {
      const matches = await findAccountsByEmailFlexible(email);

      if (matches.length === 0) {
        return res.status(404).json({ error: GOOGLE_NO_ACCOUNT_MSG });
      }

      if (matches.length > 1) {
        // Dual-role case, same pattern as password login: let the
        // person pick which account, then re-submit with accountType
        // attached (no password to disambiguate with here, since
        // Google already proved the email - every match is a valid
        // destination).
        return res.status(200).json({
          needsAccountPicker: true,
          options: matches.map((m) => ({ accountType: m.accountType, id: m.account.id, label: accountTypeLabel(m.accountType, m.account) })),
        });
      }

      accountType = matches[0].accountType;
      account = matches[0].account;
      ({ table, phoneField } = accountTable(accountType));
    }

    if (account.locked_until && new Date(account.locked_until) > new Date()) {
      // Structured `lockedUntil` (ISO) alongside the message so the
      // frontend can render a plain-language, live-ticking countdown
      // instead of parsing/displaying the raw timestamp itself.
      return res.status(423).json({
        error: 'Account temporarily locked due to repeated failed attempts.',
        lockedUntil: account.locked_until,
      });
    }

    const googleModSuspension = moderationSuspensionError(account);
    if (googleModSuspension) return res.status(googleModSuspension.status).json(googleModSuspension.body);

    if (accountType === 'tenant' && account.landlord_id) {
      const tenantUnavailable = await tenantSubscriptionUnavailableError(account.landlord_id);
      if (tenantUnavailable) return res.status(tenantUnavailable.status).json(tenantUnavailable.body);
    }

    if (accountType === 'landlord' && account.subscription_status === 'suspended') {
      return res.status(403).json({ error: 'Your account has been suspended. Contact RentaPay support for more information.', suspended: true });
    }

    if (accountType === 'landlord' && account.subscription_status === 'pending') {
      return res.status(200).json({
        paymentPending: true,
        landlordId: account.id,
        phone: account[phoneField],
        message: 'Your subscription payment has not been confirmed yet. Log in with your password to complete or verify payment.',
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
      if (parentLandlord?.subscription_status === 'suspended') {
        return res.status(403).json({ error: "The landlord's account has been suspended. Contact RentaPay support for more information.", suspended: true });
      }
      subscriptionExpired = parentLandlord?.subscription_status === 'expired';
    }

    // Google has already proven this person owns the email address -
    // that's at least as strong a proof of identity as our own OTP
    // flow, so an account that was still sitting unverified (e.g. a
    // tenant who never entered their OTP) is verified here rather than
    // routed through a separate OTP screen it has no need for anymore.
    if (!account.is_verified) {
      await supabase.from(table).update({ is_verified: true }).eq('id', account.id);
    }

    supabase.from(table).update({ failed_login_attempts: 0, locked_until: null }).eq('id', account.id)
      .then(({ error: resetErr }) => { if (resetErr) { logger.error('[auth] loginWithGoogle: failed to reset attempt counter (non-fatal):', resetErr.message); captureException(resetErr); } });

    const token = signToken(
      accountType === 'manager'
        ? { id: account.id, role: accountType, landlordId: account.landlord_id, roleLevel: account.role_level || 'manager' }
        : { id: account.id, role: accountType }
    );

    const googleResume = accountType === 'landlord' ? await computeLandlordResumeStep(account) : null;

    return res.json({
      token,
      mustChangePassword: account.must_change_password || false,
      setupWizardComplete: accountType === 'landlord' ? account.setup_wizard_complete : undefined,
      setupWizardStep: googleResume?.step,
      setupWizardPropertyId: googleResume?.defaultPropertyId,
      role: accountType,
      roleLevel: accountType === 'manager' ? account.role_level || 'manager' : undefined,
      subscriptionExpired,
      phone: account[phoneField],
    });
  } catch (err) {
    logger.error('[auth] loginWithGoogle error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to log in with Google.' });
  }
}

// ---------------------------------------------------------------------
// SUPER ADMIN LOGIN (blueprint 13.3 - hardcoded single account, 2FA)
// ---------------------------------------------------------------------
async function adminLogin(req, res) {
  try {
    const { password } = req.body;
    const adminEmail = process.env.SUPER_ADMIN_EMAIL || SUPPORT_EMAIL;

    // FIX (direct request: "there should be a way for an admin to
    // secretly change the password"): the DB-stored hash - settable
    // in-app via changeAdminPassword() below - takes priority over the
    // env var the moment it's ever been set, so a password change
    // takes effect immediately with no redeploy. Until the admin
    // changes it for the first time, this column is null and the env
    // var keeps working exactly as it always has.
    const { data: settings } = await supabase
      .from('platform_settings')
      .select('admin_password_hash')
      .eq('id', 1)
      .maybeSingle();
    const adminPasswordHash = settings?.admin_password_hash || process.env.SUPER_ADMIN_PASSWORD_HASH;

    if (!adminPasswordHash) {
      logger.error('[auth] adminLogin: no admin password set (neither platform_settings nor SUPER_ADMIN_PASSWORD_HASH env var).');
      return res.status(503).json({ error: 'Admin login is temporarily unavailable. Contact the platform developer.' });
    }

    const matches = await comparePassword(password, adminPasswordHash);
    if (!matches) {
      try {
        await sendEmail(adminEmail, 'RentaPay Admin Alert', wrapEmailHtml('A WRONG password attempt was just made on the admin panel.'));
      } catch (emailErr) {
        logger.warn('[auth] adminLogin: wrong-password alert email failed (non-fatal):', emailErr.message);
        captureException(emailErr);
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
      logger.error('[auth] adminLogin: OTP email failed to send. OTP is still valid - check here:', otp, '| Error:', emailErr.message);
      captureException(emailErr);
    }

    return res.json({ message: 'Password correct. OTP sent to admin email, expires in 5 minutes.' });
  } catch (err) {
    logger.error('[auth] adminLogin error:', err.message);
    captureException(err);
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
    logger.error('[auth] adminVerifyOTP error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to verify admin OTP.' });
  }
}

// ---------------------------------------------------------------------
// ADMIN FORGOT PASSWORD (logged-out recovery path)
//
// DIRECT REQUEST: "there should be a way an admin changes lol password
// from the admin login page... currently it's only in-app... when
// requesting to change password just send the reset code, don't ask
// FIX (direct request: "when he taps forgot password, first it
// should ask for email, and it should only accept the correct admin
// email, otherwise no code should ever unlock... only send email if
// the email is the right one"): now requires the caller to submit an
// email address, and only ever generates/sends a real reset code when
// it exactly matches the one known admin address. A wrong email gets
// the exact same generic response as a right one (no "that's not the
// admin email" signal) - but no OTP is stored, so no code sent to
// anyone else could ever pair with a live reset session. That's the
// actual security boundary here, not the copy on the response.
// ---------------------------------------------------------------------
async function adminForgotPassword(req, res) {
  try {
    const { email } = req.body;
    const adminEmail = process.env.SUPER_ADMIN_EMAIL || SUPPORT_EMAIL;
    const submitted = String(email || '').trim().toLowerCase();
    const matches = submitted && adminEmail && submitted === String(adminEmail).trim().toLowerCase();

    if (matches) {
      const otp = generateOTP();
      global.__adminPasswordResetOtpStore = { otp, expiresAt: getPasswordResetOTPExpiry() };

      try {
        await sendEmail(adminEmail, 'Your RentaPay admin password reset code', wrapEmailHtml(templates.adminOtpMessage(otp)));
      } catch (emailErr) {
        // Same reasoning as the login-OTP email failure below: the OTP
        // was already generated and stored, so a broken email provider
        // must not strand the admin with no way to see it - log it
        // loudly rather than 500ing the request.
        logger.error('[auth] adminForgotPassword: reset code email failed to send. Code is still valid - check here:', otp, '| Error:', emailErr.message);
        captureException(emailErr);
      }
    } else {
      // Wrong (or missing) email: deliberately do nothing that could
      // produce a working reset - no OTP generated, no email sent -
      // while still returning the same response shape as the match
      // case below, so the response itself can't be used to probe for
      // the real admin address.
      global.__adminPasswordResetOtpStore = null;
    }

    // Same generic response either way - never confirms or denies
    // whether the submitted email was the real admin address.
    return res.json({ message: 'If that email is registered as the admin account, a reset code has been sent to it.' });
  } catch (err) {
    logger.error('[auth] adminForgotPassword error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to send a reset code. Please try again.' });
  }
}

async function adminResetPassword(req, res) {
  try {
    const { otp, newPassword, confirmPassword } = req.body;
    if (!otp || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'The code, new password, and confirmation are all required.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match.' });
    }

    const strength = validatePasswordStrength(newPassword);
    if (!strength.isValid) {
      return res.status(400).json({ error: strength.errors.join(' ') });
    }

    const store = global.__adminPasswordResetOtpStore;
    if (!store || store.otp !== otp) {
      return res.status(400).json({ error: 'Invalid reset code.' });
    }
    if (isOTPExpired(store.expiresAt)) {
      global.__adminPasswordResetOtpStore = null;
      return res.status(400).json({ error: 'This reset code has expired. Request a new one.' });
    }

    const newHash = await hashPassword(newPassword);
    const { error } = await supabase
      .from('platform_settings')
      .update({ admin_password_hash: newHash })
      .eq('id', 1);
    if (error) throw error;

    global.__adminPasswordResetOtpStore = null;
    global.__adminOtpStore = null; // also invalidate any in-flight login-2FA OTP, since the password just changed

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'admin_password_reset', ipAddress: req.ip });

    const adminEmail = process.env.SUPER_ADMIN_EMAIL || SUPPORT_EMAIL;
    try {
      await sendEmail(adminEmail, 'RentaPay Admin Alert', wrapEmailHtml('The admin password was just reset via the "Forgot password?" flow. If this was not you, contact the platform developer immediately.'));
    } catch (emailErr) {
      logger.warn('[auth] adminResetPassword: confirmation alert email failed (non-fatal):', emailErr.message);
      captureException(emailErr);
    }

    return res.json({ message: 'Password reset. You can now log in with your new password.' });
  } catch (err) {
    logger.error('[auth] adminResetPassword error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to reset the password.' });
  }
}

// ---------------------------------------------------------------------
// CHANGE ADMIN PASSWORD (direct request: "there should be a way for
// an admin to secretly change the password" now that it isn't just a
// plain env var edit anymore). Deliberately not linked from any nav -
// same "secret by being unlinked, not by being unauthenticated" pattern
// as the admin login URL itself. Requires a valid admin JWT (so only
// someone already logged in as admin can reach it) AND the current
// password, so a stolen/leaked admin token alone isn't enough to lock
// the real admin out.
// ---------------------------------------------------------------------
async function changeAdminPassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required.' });
    }

    const strength = validatePasswordStrength(newPassword);
    if (!strength.isValid) {
      return res.status(400).json({ error: strength.errors.join(' ') });
    }

    const { data: settings } = await supabase
      .from('platform_settings')
      .select('admin_password_hash')
      .eq('id', 1)
      .maybeSingle();
    const currentHash = settings?.admin_password_hash || process.env.SUPER_ADMIN_PASSWORD_HASH;

    if (!currentHash) {
      logger.error('[auth] changeAdminPassword: no admin password set (neither platform_settings nor SUPER_ADMIN_PASSWORD_HASH env var).');
      return res.status(503).json({ error: 'Admin login is temporarily unavailable. Contact the platform developer.' });
    }

    const currentMatches = await comparePassword(currentPassword, currentHash);
    if (!currentMatches) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await hashPassword(newPassword);
    const { error } = await supabase
      .from('platform_settings')
      .update({ admin_password_hash: newHash })
      .eq('id', 1);
    if (error) throw error;

    const adminEmail = process.env.SUPER_ADMIN_EMAIL || SUPPORT_EMAIL;
    try {
      await sendEmail(adminEmail, 'Your RentaPay admin password was changed', wrapEmailHtml('The admin panel password was just changed. If this wasn\u2019t you, contact the platform developer immediately.'));
    } catch (emailErr) {
      logger.warn('[auth] changeAdminPassword: confirmation email failed (non-fatal):', emailErr.message);
      captureException(emailErr);
    }

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'admin_password_changed', ipAddress: req.ip });

    return res.json({ message: 'Admin password changed. Use it next time you log in.' });
  } catch (err) {
    logger.error('[auth] changeAdminPassword error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to change admin password.' });
  }
}


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
    logger.error('[auth] completeSetupWizard error:', err.message);
    captureException(err);
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
    logger.error('[auth] updatePropertyDetails error:', err.message);
    captureException(err);
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
      .select('id, full_name, phone, email, photo_url, payment_method, paybill_number, paybill_account_number, till_number, gender, notification_style, onboarding_dismissed_at, whatsapp_number, kra_pin, ba_id, ba_attribution_disputed')
      .eq('id', landlordId)
      .single();
    if (error || !landlord) return res.status(404).json({ error: 'Account not found.' });

    return res.json({
      contact: {
        fullName: landlord.full_name,
        phone: landlord.phone,
        whatsappNumber: landlord.whatsapp_number || '',
        email: landlord.email || '',
        gender: landlord.gender || null,
        notificationStyle: landlord.notification_style || 'ring',
        // Section 6: KRA PIN / business registration number, printed
        // on payment receipts when present. Optional - many landlords
        // won't have filled this in.
        kraPin: landlord.kra_pin || '',
      },
      paymentMethod: {
        method: landlord.payment_method || 'stk',
        paybillNumber: landlord.paybill_number || '',
        accountNumber: landlord.paybill_account_number || '',
        tillNumber: landlord.till_number || '',
      },
      photoUrl: landlord.photo_url,
      // Phase 14 - "identity never revealed": the client only ever
      // learns WHETHER an ambassador is attached to this account and
      // whether a dispute is already on file - never ba_id itself, a
      // BA name, or a BA code. Settings.jsx uses `eligible` to decide
      // whether to show the dispute prompt at all, and `disputed` to
      // swap it for a "we're reviewing this" line instead of letting
      // it be raised twice.
      baAttribution: {
        eligible: !!landlord.ba_id,
        disputed: !!landlord.ba_attribution_disputed,
      },
    });
  } catch (err) {
    logger.error('[auth] getMyLandlordProfile error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch your profile.' });
  }
}

// ---------------------------------------------------------------------
// DISPUTE BA ATTRIBUTION (landlord only) - Phase 14. Lets a landlord
// say "I wasn't onboarded by an ambassador" without this endpoint, or
// its response, ever confirming which BA (or that a BA exists at all)
// is tied to their account. Scoped to the calling landlord's own id
// from the JWT, same pattern as updateMyContact/updatePaymentMethod
// above - never a client-supplied landlordId.
//
// Deliberately a no-op-but-still-generic response when the account
// has no ba_id at all: the frontend only shows the prompt when
// ba_id is set (per getMyLandlordProfile above), but a direct API
// call with no attribution to dispute still gets the same neutral
// confirmation rather than a different status code/message that
// would itself leak whether an attribution exists.
// ---------------------------------------------------------------------
async function disputeBaAttribution(req, res) {
  try {
    const landlordId = req.user.id;
    const { data: landlord, error: fetchError } = await supabase
      .from('landlords')
      .select('id, ba_id, ba_attribution_disputed')
      .eq('id', landlordId)
      .single();
    if (fetchError || !landlord) return res.status(404).json({ error: 'Account not found.' });

    if (landlord.ba_id && !landlord.ba_attribution_disputed) {
      const { error: updateError } = await supabase
        .from('landlords')
        .update({ ba_attribution_disputed: true, ba_attribution_disputed_at: new Date().toISOString() })
        .eq('id', landlordId);
      if (updateError) throw updateError;

      // No BA name/code/id in the log's visible fields either - admin
      // can join ba_landlord_claims -> brand_ambassadors themselves
      // (see getBaSecurityReport's disputedAttributions signal) when
      // they actually need to look into it.
      logActivity({ actorType: 'landlord', actorId: landlordId, action: 'ba_attribution_disputed', targetType: 'landlord', targetId: landlordId });
    }

    return res.json({ message: "Thanks, we'll review this." });
  } catch (err) {
    logger.error('[auth] disputeBaAttribution error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit this. Please try again.' });
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
      .select('payment_method, paybill_number, paybill_account_number, till_number, stk_phone_number, payment_description')
      .eq('id', landlordId)
      .single();
    if (error || !landlord) return res.status(404).json({ error: 'Account not found.' });

    let property = null;
    if (propertyId) {
      const { data } = await supabase
        .from('properties')
        .select('payment_override_enabled, payment_override_method, payment_override_paybill_number, payment_override_paybill_account_number, payment_override_till_number, payment_override_stk_phone_number, payment_override_description')
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
      description: property.payment_override_description,
    } : landlord;

    return res.json({
      paymentMethod: {
        method: source.payment_method || source.method || 'stk',
        paybillNumber: (overridden ? source.paybill_number : landlord.paybill_number) || '',
        accountNumber: (overridden ? source.paybill_account_number : landlord.paybill_account_number) || '',
        tillNumber: (overridden ? source.till_number : landlord.till_number) || '',
        stkPhoneNumber: (overridden ? source.stk_phone_number : landlord.stk_phone_number) || '',
        // Free-text note shown to the tenant when they tap Pay Rent /
        // Pay <utility>, e.g. "Rent due by the 5th; water billed
        // separately." Same override precedence as everything else.
        description: (overridden ? source.description : landlord.payment_description) || '',
        isApartmentSpecific: overridden,
      },
    });
  } catch (err) {
    logger.error('[auth] getPaymentMethodForViewer error:', err.message);
    captureException(err);
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
    const { fullName, gender, notificationStyle } = req.body;
    let { phone, whatsappNumber } = req.body;

    // FIX (adopt the same pattern updateMyProfile in
    // brandAmbassador.controller.js already uses): reject only an
    // actual CHANGE to phone/email, not merely their presence in the
    // body. The old version 400'd on presence alone, so any form that
    // shows phone/email as pre-filled read-only fields (which is how
    // every one of these forms is built - see Settings.jsx) failed to
    // save ANYTHING, even an unrelated field like the KRA PIN, purely
    // because phone/email rode along unchanged in the payload.
    if (req.body.email !== undefined) {
      const { data: current, error: fetchErr } = await supabase.from('landlords').select('email').eq('id', landlordId).maybeSingle();
      if (fetchErr) throw fetchErr;
      if (String(req.body.email).trim().toLowerCase() !== (current?.email || '').toLowerCase()) {
        return res.status(400).json({ error: 'Your primary email cannot be changed after registration. Contact support if you need to update it.' });
      }
    }
    if (phone !== undefined) {
      const { data: current, error: fetchErr } = await supabase.from('landlords').select('phone').eq('id', landlordId).maybeSingle();
      if (fetchErr) throw fetchErr;
      let normalizedPhone;
      try {
        normalizedPhone = normalizePhoneOrThrow(phone, 'Phone number');
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
      if (normalizedPhone !== current?.phone) {
        return res.status(400).json({ error: 'Your primary phone number cannot be changed after registration. Contact support if you need to update it.' });
      }
    }

    const updateFields = {};
    if (fullName !== undefined) {
      if (!fullName.trim()) return res.status(400).json({ error: 'Full name cannot be empty.' });
      updateFields.full_name = fullName.trim();
    }
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
    // Public-facing WhatsApp number shown to strangers browsing free
    // vacant-unit listings - deliberately separate from the login
    // phone above so a landlord isn't forced to hand out the same
    // number they use for OTPs/M-Pesa. Required at signup; editable
    // any time here.
    if (whatsappNumber !== undefined) {
      if (!whatsappNumber) return res.status(400).json({ error: 'WhatsApp number cannot be empty.' });
      try {
        updateFields.whatsapp_number = normalizePhoneOrThrow(whatsappNumber, 'WhatsApp number');
      } catch (waErr) {
        return res.status(400).json({ error: waErr.message });
      }
    }
    // Section 6: KRA PIN / business registration number for the
    // receipt PDF. Optional and clearable (send an empty string to
    // remove it).
    if (req.body.kraPin !== undefined) {
      updateFields.kra_pin = req.body.kraPin ? String(req.body.kraPin).trim() : null;
    }

    if (!Object.keys(updateFields).length) return res.status(400).json({ error: 'No fields to update.' });

    const { data: updated, error } = await supabase.from('landlords').update(updateFields).eq('id', landlordId).select('id, full_name, phone, email, gender, notification_style, whatsapp_number, kra_pin').single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That phone number is already in use by another account.' });
      throw error;
    }

    logActivity({ actorType: 'landlord', actorId: landlordId, action: 'contact_details_updated', targetType: 'landlord', targetId: landlordId });

    return res.json({ message: 'Contact details updated.', contact: updated });
  } catch (err) {
    logger.error('[auth] updateMyContact error:', err.message);
    captureException(err);
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
    const { method, paybillNumber, accountNumber, tillNumber, stkPhoneNumber, description, propertyId, useDefault } = req.body;

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

      const { data: landlordRow } = await supabase.from('landlords').select('payment_method, paybill_number, paybill_account_number, till_number, payment_description').eq('id', landlordId).single();
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
            payment_override_description: description !== undefined ? (description || null) : undefined,
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
          payment_description: description !== undefined ? (description || null) : undefined,
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
    logger.error('[auth] updatePaymentMethod error:', err.message);
    captureException(err);
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
      return res.status(400).json({ error: "accountType must be 'landlord', 'tenant', or 'manager'." });
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

    const rateCheck = checkAndRecordResend('otp', `${accountType}:${phone}`);
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: `Too many attempts. Please try again in ${rateCheck.retryAfterMinutes} minute(s).` });
    }

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
        logger.error('[auth] resendOTP: email send failed - this account has no other delivery channel:', emailErr.message);
        captureException(emailErr);
      }
    } else {
      logger.warn(`[auth] resendOTP: no email on file for ${accountType} ${account.id} - OTP has nowhere to be delivered.`);
    }

    logActivity({ actorType: 'system', action: 'otp_resent', targetType: accountType, targetId: account.id });

    // Report where the code actually went (email - see sendEmail call
    // above; there is no SMS delivery path for OTPs) so the frontend
    // never has to guess or hardcode a channel that may not be true.
    return res.json({ message: 'A new verification code has been sent.', accountId: account.id, email: account.email || null });
  } catch (err) {
    logger.error('[auth] resendOTP error:', err.message);
    captureException(err);
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
      logger.warn('[auth] changePassword: confirmation email failed (non-fatal, password was already changed):', emailErr.message);
      captureException(emailErr);
    }

    logActivity({ actorType: role, actorId: id, action: 'password_changed', targetType: role, targetId: id });

    return res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    logger.error('[auth] changePassword error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to change password.' });
  }
}

// ---------------------------------------------------------------------
// FORGOT PASSWORD (landlord or tenant, NOT authenticated - this is
// exactly for someone who's locked out and can't get a token). Two
// steps: request a reset code by email, then submit that code + a new
// password. Reuses the same otp_code/otp_expires_at columns as
// account verification - fine, since the two purposes never overlap
// in time for a given account (you can't be mid-reset and mid-verify
// at once), and it means no new columns needed.
//
// FIX (direct request: "change such that it only asks for the email
// and not phone number"): this used to also accept a phone number as
// the lookup key. Phone support removed entirely - email is now the
// only identifier accepted, and the OTP is only ever sent (as it
// always was) to that same account's email.
// ---------------------------------------------------------------------
async function requestPasswordReset(req, res) {
  try {
    let { email, accountType } = req.body;

    // PASSWORD RESET UNIFICATION: accountType is still optional, same
    // as login(). Unlike login, there's no password yet at this step
    // to silently disambiguate a dual-role account with, so every
    // matched account type gets the exact same reset code written to
    // it - the *next* step (resetPassword, below) is where a
    // genuinely ambiguous case gets resolved, by reusing login()'s
    // account-picker pattern.
    if (accountType && !ALL_ACCOUNT_TYPES.includes(accountType)) {
      return res.status(400).json({ error: "accountType, if provided, must be 'landlord', 'manager', or 'tenant'." });
    }
    if (!email) {
      return res.status(400).json({ error: 'email is required.' });
    }
    email = String(email).trim();

    // Rate limit BEFORE the account lookup, keyed on the raw email
    // string, so a blocked/allowed response never differs based on
    // whether the email is actually registered - preserves the
    // existing "same response either way" anti-enumeration behaviour
    // just below.
    const rateCheck = checkAndRecordResend('password-reset', email);
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: `Too many attempts. Please try again in ${rateCheck.retryAfterMinutes} minute(s).` });
    }

    let matches;
    if (accountType) {
      const { table } = accountTable(accountType);
      // ARCHIVE FIX: same is_active scoping as findAccountsByEmail -
      // otherwise an archived manager/tenant row sharing an email
      // with a newly re-added active one makes maybeSingle() see two
      // rows and error out, silently sending back "no account found"
      // for a real, active account.
      let lookupQuery = supabase.from(table).select('*').ilike('email', email);
      if (accountType !== 'landlord') lookupQuery = lookupQuery.eq('is_active', true);
      const { data } = await lookupQuery.maybeSingle();
      matches = data ? [{ accountType, account: data }] : [];
    } else {
      matches = await findAccountsByEmail(email);
    }

    // Deliberately return the same success message regardless of how
    // many (if any) accounts matched - so this endpoint can't be used
    // to check which email addresses are registered, or how many
    // account types a given email has. The OTP is only actually sent
    // if at least one account was found.
    if (matches.length > 0) {
      // FEATURE (direct request: "if they try to change the password
      // it returns the error account suspended... and it doesn't send
      // the OTP"): this is a deliberate departure from the generic
      // "if that email is registered..." response below (which
      // exists to prevent email-enumeration) - a suspended account
      // gets told plainly, and gets nothing sent. If this email
      // matches a dual-role account where only ONE role is suspended,
      // the other role's reset still proceeds normally below; only an
      // email where EVERY matched account is suspended short-circuits
      // here.
      const eligibleMatches = matches.filter(({ account }) => !moderationSuspensionError(account));
      if (eligibleMatches.length === 0) {
        const modErr = moderationSuspensionError(matches[0].account);
        return res.status(modErr.status).json(modErr.body);
      }
      matches = eligibleMatches;

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
      // that was matched on, so it's always present.
      await Promise.all(
        matches.map(({ account }) =>
          sendEmail(account.email, 'Your RentaPay password reset code', wrapEmailHtml(templates.passwordResetOtpMessage(otp)))
            .catch((emailErr) => { logger.error('[auth] requestPasswordReset: email send failed for account', account.id, ':', emailErr.message); captureException(emailErr); })
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
            logger.warn('[auth] requestPasswordReset: failed to log to password_reset_requests (non-fatal):', logErr.message);
            captureException(logErr);
          }
        })
      );
    }

    return res.json({ message: 'If that email is registered with us, a reset code has been sent to it.' });
  } catch (err) {
    logger.error('[auth] requestPasswordReset error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to process reset request.' });
  }
}

async function resetPassword(req, res) {
  try {
    let { email, accountType, otp, newPassword } = req.body;

    if (accountType && !ALL_ACCOUNT_TYPES.includes(accountType)) {
      return res.status(400).json({ error: "accountType, if provided, must be 'landlord', 'manager', or 'tenant'." });
    }
    // FIX (direct request: email-only reset): phone lookup removed -
    // whichever email the person used to request the code is the one
    // the frontend resubmits here.
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: 'email, otp, and newPassword are required.' });
    }
    email = String(email).trim();

    // Same error either way (account not found vs wrong OTP) so this
    // can't be used to confirm which accounts exist.
    const genericError = { error: 'Invalid code.' };

    let matches;
    if (accountType) {
      // Disambiguation re-submit from the account picker below (otp +
      // newPassword unchanged, accountType now attached).
      const { table } = accountTable(accountType);
      // ARCHIVE FIX: same is_active scoping as findAccountsByEmail -
      // otherwise an archived manager/tenant row sharing an email
      // with a newly re-added active one makes maybeSingle() see two
      // rows and error out, silently reporting "Invalid code" for a
      // real, active account with a correct OTP.
      let lookupQuery = supabase.from(table).select('*').ilike('email', email);
      if (accountType !== 'landlord') lookupQuery = lookupQuery.eq('is_active', true);
      const { data } = await lookupQuery.maybeSingle();
      matches = data ? [{ accountType, account: data }] : [];
    } else {
      matches = await findAccountsByEmail(email);
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

    // Defense-in-depth: covers the narrow race where an account was
    // suspended AFTER requestPasswordReset already sent a still-valid
    // code but BEFORE this step - without this, that code would still
    // work right up until it expires.
    const resetModSuspension = moderationSuspensionError(account);
    if (resetModSuspension) return res.status(resetModSuspension.status).json(resetModSuspension.body);

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
      logger.warn('[auth] resetPassword: confirmation email failed (non-fatal, password was already changed):', emailErr.message);
      captureException(emailErr);
    }

    logActivity({ actorType: resolvedType, actorId: account.id, action: 'password_reset', targetType: resolvedType, targetId: account.id });

    clearResendAttempts('password-reset', email);
    return res.json({ message: 'Password reset successfully. You can now log in with your new password.' });
  } catch (err) {
    logger.error('[auth] resetPassword error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
}

module.exports = {
  registerLandlord,
  requestLandlordEmailVerification,
  confirmLandlordEmailVerification,
  activateLandlordAfterPayment,
  verifyOTP,
  verifyLandlordEmailOTP,
  resendLandlordEmailOTP,
  initiateLandlordSubscriptionPayment,
  updateLandlordRegistrationEmail,
  resendOTP,
  login,
  loginWithGoogle,
  generalManagerLogin,
  adminLogin,
  adminVerifyOTP,
  adminForgotPassword,
  adminResetPassword,
  changeAdminPassword,
  completeSetupWizard,
  getMyLandlordProfile,
  disputeBaAttribution,
  dismissOnboarding,
  getPaymentMethodForViewer,
  updatePropertyDetails,
  updateMyContact,
  updatePaymentMethod,
  changePassword,
  requestPasswordReset,
  resetPassword,
  // Exported so other controllers can reuse the exact same
  // account-table mapping and cross-role phone lookup, rather than
  // re-implementing a second copy that could drift out of sync.
  accountTable,
  findAccountsByPhone,
  ALL_ACCOUNT_TYPES,
};
