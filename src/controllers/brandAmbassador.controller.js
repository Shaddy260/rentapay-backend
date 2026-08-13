// src/controllers/brandAmbassador.controller.js
//
// BUILD SPEC PHASE 2 - Admin: Generic BA Onboarding Link, Self-Fill,
// Email Confirm & Approval.
//
// One generic, always-live public link (/become-a-ba on the
// frontend) admin shares with anyone they want to become a Brand
// Ambassador - NOT a per-person token like tenant onboarding. The
// prospective BA fills in their own name/phone/email, must confirm
// email ownership via a one-time code before they can submit, and the
// submission then sits in a `pending_approval` queue. Nothing is
// auto-activated - admin explicitly approves or rejects every
// application (see approveBaApplication / rejectBaApplication).
//
// Mirrors tenantOnboarding.controller.js's email-OTP shape (same
// generateOTP/getEmailVerificationOTPExpiry/isOTPExpired utilities,
// same email.service.js send) but with one structural difference: a
// tenant onboarding OTP is scoped to an existing onboarding_link_id
// row, whereas here NO brand_ambassadors row exists yet at OTP-send
// time (see requestBaEmailVerification below - deliberately does not
// create one). The OTP is instead scoped to the raw email string in
// its own table, and confirmBaEmailVerification hands back a
// short-lived opaque verification token the frontend must echo back
// on submitBaOnboarding as proof this exact email was confirmed in
// this same flow.

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { hashPassword, comparePassword } = require('../utils/password');
const { generateOTP, getEmailVerificationOTPExpiry, isOTPExpired } = require('../utils/otp');
const { resolveApplicableRate } = require('../services/baCommission.service');
const { maskPhoneMiddle } = require('../utils/maskPhone');

const { isValidEmail } = require('../utils/email');
const { findPhoneConflict } = require('../utils/phoneUniqueness');
const { normalizePhoneOrThrow } = require('../utils/phone');
const { findEmailConflict } = require('../utils/emailUniqueness');
const { sendEmail, wrapEmailHtml, SUPPORT_EMAIL } = require('../services/email.service');
const { sendSMS } = require('../services/sms.service');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const { notify } = require('../services/notify.service');
const { queueBatchedNotification } = require('../services/notificationBatch.service');
const { sendPushToRecipient } = require('../services/webpush.service');
const logger = require('../utils/logger');

// Bumped only if the Terms of Engagement copy materially changes -
// stamped onto every application at submission time (terms_version)
// so a later dispute can always be traced back to exactly which
// version of the terms a given BA agreed to.
const BA_TERMS_VERSION = '2026-08-v1';

// Same shape as propertyManager.controller.js's generateTempPassword -
// reused verbatim rather than re-invented, since it's already the
// convention for "first login, forced change" credentials in this app.
function generateTempPassword() {
  return `Rp${crypto.randomBytes(3).toString('hex')}!`;
}

function generateVerificationToken() {
  return crypto.randomBytes(24).toString('hex');
}

const BA_ONBOARDING_LINK_TTL_HOURS = 24;

function generateOnboardingLinkToken() {
  return crypto.randomBytes(20).toString('hex');
}

// ---------------------------------------------------------------------
// Shared helper - the current live link is always just the most
// recently generated row. Nothing marks old rows inactive; a new
// generation simply makes itself the newest row, which is what both
// "regenerate early kills the old one" and "expires after 24h" mean
// in practice once we always look at only the latest row.
// ---------------------------------------------------------------------
async function getCurrentBaOnboardingLink() {
  const { data, error } = await supabase
    .from('ba_onboarding_links')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function isLinkExpired(link) {
  return !link || new Date(link.expires_at) <= new Date();
}

// Shared gate for both public onboarding steps - the applicant's
// frontend must echo back whichever token it read from the URL. If no
// link has ever been generated, if the token doesn't match the
// current one (e.g. an old copy-pasted link after a regenerate), or
// if it's past its 24h expiry, the applicant is turned away with the
// same "request a new one" message rather than being let through.
async function checkOnboardingLinkToken(token) {
  if (!token) {
    return { ok: false, error: 'This onboarding link is invalid. Please request a new one from RentaPay.' };
  }
  const current = await getCurrentBaOnboardingLink();
  if (isLinkExpired(current) || current.token !== String(token)) {
    return { ok: false, error: 'This onboarding link has expired. Please request a new one from RentaPay.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------
// PUBLIC - lets the /become-a-ba page check, on load, whether the
// ?token= it was opened with is still good, so it can show the
// "expired, request another" message before the applicant even starts
// filling in the form (rather than only finding out at submit time).
// ---------------------------------------------------------------------
async function validateBaOnboardingLinkToken(req, res) {
  try {
    const { token } = req.query;
    const result = await checkOnboardingLinkToken(token);
    if (!result.ok) return res.status(410).json({ valid: false, error: result.error });
    return res.json({ valid: true });
  } catch (err) {
    logger.error('[brandAmbassador] validateBaOnboardingLinkToken error:', err.message);
    captureException(err);
    return res.status(500).json({ valid: false, error: 'Failed to validate link.' });
  }
}

// ---------------------------------------------------------------------
// ADMIN - current link status, for the admin portal's "Onboard a new
// Brand Ambassador" card to show the live link + a countdown/expired
// state without generating a new one just to look at it.
// ---------------------------------------------------------------------
async function getBaOnboardingLinkStatus(req, res) {
  try {
    const current = await getCurrentBaOnboardingLink();
    const expired = isLinkExpired(current);
    return res.json({
      link: current && !expired ? `${FRONTEND_URL}/become-a-ba?token=${current.token}` : null,
      expiresAt: current?.expires_at || null,
      expired,
    });
  } catch (err) {
    logger.error('[brandAmbassador] getBaOnboardingLinkStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the onboarding link.' });
  }
}

// ---------------------------------------------------------------------
// ADMIN - generate (or regenerate) the onboarding link. Always inserts
// a fresh row and fresh token, so regenerating early immediately
// invalidates whatever link was live before - there's no window where
// two tokens both work. Expires 24h from generation.
// ---------------------------------------------------------------------
async function generateBaOnboardingLink(req, res) {
  try {
    const token = generateOnboardingLinkToken();
    const expiresAt = new Date(Date.now() + BA_ONBOARDING_LINK_TTL_HOURS * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('ba_onboarding_links')
      .insert({ token, generated_by: req.user?.id || null, expires_at: expiresAt.toISOString() })
      .select()
      .single();
    if (error) throw error;

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'ba_onboarding_link_generated', targetType: 'ba_onboarding_link', targetId: data.id });

    return res.status(201).json({
      link: `${FRONTEND_URL}/become-a-ba?token=${token}`,
      expiresAt: data.expires_at,
    });
  } catch (err) {
    logger.error('[brandAmbassador] generateBaOnboardingLink error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to generate a new onboarding link.' });
  }
}

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rentapay.co.ke';

// ---------------------------------------------------------------------
// PUBLIC - step 1: send a code to the email the applicant typed.
// Deliberately does NOT touch brand_ambassadors at all - the person
// hasn't submitted anything yet, this only proves they control the
// address before they're allowed to.
// ---------------------------------------------------------------------
async function requestBaEmailVerification(req, res) {
  try {
    const { email, onboardingToken } = req.body;
    const linkCheck = await checkOnboardingLinkToken(onboardingToken);
    if (!linkCheck.ok) return res.status(410).json({ error: linkCheck.error, linkExpired: true });

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    const otp = generateOTP();
    const expiresAt = getEmailVerificationOTPExpiry();

    const { error: upsertErr } = await supabase
      .from('ba_email_otps')
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
        'Verify your email - RentaPay Brand Ambassador application',
        wrapEmailHtml(`Your verification code is: ${otp}\n\nThis code expires in 10 minutes. Enter it on the Brand Ambassador application form to verify your email.`)
      );
    } catch (emailErr) {
      logger.error('[brandAmbassador] requestBaEmailVerification: failed to send:', emailErr.message);
      captureException(emailErr);
      return res.status(502).json({ error: 'Could not send the verification email. Please check the address and try again.' });
    }

    return res.json({ message: 'Verification code sent to your email.' });
  } catch (err) {
    logger.error('[brandAmbassador] requestBaEmailVerification error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to send verification code.' });
  }
}

// ---------------------------------------------------------------------
// PUBLIC - step 2: confirm the code. Returns a short-lived opaque
// token (NOT the OTP itself) the frontend must send back on
// submitBaOnboarding - proves this exact email was confirmed in this
// same flow without the frontend having to re-transmit the OTP.
// ---------------------------------------------------------------------
async function confirmBaEmailVerification(req, res) {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const { data: record, error: recordErr } = await supabase
      .from('ba_email_otps')
      .select('*')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (recordErr) throw recordErr;
    if (!record) return res.status(400).json({ error: 'Request a verification code for this email first.' });

    // Same 5-strikes lockout convention as tenantOnboarding's
    // verifyOnboardingEmailOtp - a 6-digit code otherwise has no real
    // guard against unlimited guessing.
    if (record.locked_until && new Date(record.locked_until) > new Date()) {
      return res.status(423).json({ error: `Too many incorrect codes. Try again after ${record.locked_until}, or request a new code.` });
    }
    if (isOTPExpired(record.expires_at)) {
      return res.status(400).json({ error: 'That code has expired. Request a new one.' });
    }
    if (record.otp_code !== String(code).trim()) {
      const failedAttempts = (record.failed_attempts || 0) + 1;
      const update = { failed_attempts: failedAttempts };
      if (failedAttempts >= 5) {
        const lockUntil = new Date();
        lockUntil.setMinutes(lockUntil.getMinutes() + 15);
        update.locked_until = lockUntil.toISOString();
      }
      await supabase.from('ba_email_otps').update(update).eq('id', record.id);
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }

    const verificationToken = generateVerificationToken();
    await supabase
      .from('ba_email_otps')
      .update({ verified: true, verification_token: verificationToken, failed_attempts: 0, locked_until: null })
      .eq('id', record.id);

    return res.json({ verified: true, emailVerification: verificationToken });
  } catch (err) {
    logger.error('[brandAmbassador] confirmBaEmailVerification error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to verify code.' });
  }
}

// ---------------------------------------------------------------------
// PUBLIC - step 3: the actual application.
// ---------------------------------------------------------------------
async function submitBaOnboarding(req, res) {
  try {
    const { fullName, emailVerification, termsAccepted, onboardingToken } = req.body;
    let { phone, email, nationalId } = req.body;

    const linkCheck = await checkOnboardingLinkToken(onboardingToken);
    if (!linkCheck.ok) return res.status(410).json({ error: linkCheck.error, linkExpired: true });

    // (item 6) national ID is now required alongside name/phone/email -
    // needed for identity verification and payouts.
    const required = { fullName, phone, email, nationalId };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) return res.status(400).json({ error: `Please fill in: ${missing.join(', ')}` });

    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    email = String(email).trim().toLowerCase();

    try {
      phone = normalizePhoneOrThrow(phone, 'Phone number');
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    nationalId = String(nationalId).trim();
    if (nationalId.length < 4 || nationalId.length > 20 || !/^[A-Za-z0-9-]+$/.test(nationalId)) {
      return res.status(400).json({ error: 'Please enter a valid national ID number.' });
    }

    // (b) terms gate - server-side, not just a client checkbox.
    if (termsAccepted !== true) {
      return res.status(400).json({ error: 'You must agree to the Brand Ambassador Terms of Engagement to apply.' });
    }

    // (a) the email must have been confirmed in THIS flow, for THIS
    // exact address, via a still-valid verification token.
    if (!emailVerification) {
      return res.status(400).json({ error: 'Please verify your email address before submitting.', emailNotVerified: true });
    }
    const { data: otpRecord, error: otpErr } = await supabase
      .from('ba_email_otps')
      .select('verified, verification_token')
      .eq('email', email)
      .maybeSingle();
    if (otpErr) throw otpErr;
    if (!otpRecord?.verified || otpRecord.verification_token !== emailVerification) {
      return res.status(400).json({ error: 'Please verify your email address before submitting.', emailNotVerified: true });
    }

    // (c) global uniqueness across every role, excluding rejected BA
    // rows (see phoneUniqueness.js / emailUniqueness.js - both already
    // extended to check brand_ambassadors with `neq('status', 'rejected')`,
    // mirroring the partial unique indexes from Phase 1).
    const [phoneConflict, emailConflict] = await Promise.all([
      findPhoneConflict(phone, 'brand_ambassador'),
      findEmailConflict(email, 'brand_ambassador'),
    ]);
    if (phoneConflict || emailConflict) {
      const fields = [];
      if (emailConflict) fields.push('email');
      if (phoneConflict) fields.push('phone');
      return res.status(409).json({
        error: emailConflict || phoneConflict,
        fields,
      });
    }

    // (d) create the pending application. ba_code/referral_code stay
    // null until approval (Phase 1: "a rejected/pending row never
    // occupies a real BA code").
    let application;
    try {
      const { data, error } = await supabase
        .from('brand_ambassadors')
        .insert({
          full_name: fullName,
          email,
          phone,
          national_id: nationalId,
          status: 'pending_approval',
          email_verified: true,
          terms_accepted_at: new Date().toISOString(),
          terms_version: BA_TERMS_VERSION,
        })
        .select()
        .single();
      if (error) throw error;
      application = data;
    } catch (insertErr) {
      // The partial unique indexes on (phone) / (lower(email)) WHERE
      // status <> 'rejected' are the real guard against two
      // near-simultaneous submissions racing past the checks above -
      // catch the resulting Postgres unique-violation and return the
      // same clear duplicate message to whichever request lost the
      // race. The applicant doesn't need to know which layer caught it.
      if (insertErr.code === '23505') {
        return res.status(409).json({
          error: 'This phone number, email address, or national ID was just registered by another application. Please check your details.',
        });
      }
      throw insertErr;
    }

    // (e) notify admin - best-effort, never blocks the response.
    if (SUPPORT_EMAIL) {
      sendEmail(
        SUPPORT_EMAIL,
        'New Brand Ambassador application awaiting review',
        wrapEmailHtml(
          `${fullName} applied to become a Brand Ambassador.\n\nPhone: ${phone}\nEmail: ${email}\nNational ID: ${nationalId}\n\nReview it in the admin portal under Brand Ambassador Applications.`
        )
      ).catch((notifyErr) => {
        logger.error('[brandAmbassador] admin notify failed:', notifyErr.message);
        captureException(notifyErr);
      });
    }

    return res.status(201).json({
      message: 'Your application has been received and is pending review.',
      application: { id: application.id, status: application.status },
    });
  } catch (err) {
    logger.error('[brandAmbassador] submitBaOnboarding error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit your application. Please try again.' });
  }
}

// ---------------------------------------------------------------------
// ADMIN
// ---------------------------------------------------------------------

const REMINDER_THRESHOLD_HOURS = 12;

function withOverdueFlag(row) {
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  return { ...row, overdue: ageMs > REMINDER_THRESHOLD_HOURS * 60 * 60 * 1000 };
}

/** GET /api/brand-ambassadors/applications?page=&pageSize= - pending queue. */
async function listPendingBaApplications(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await supabase
      .from('brand_ambassadors')
      .select('id, full_name, email, phone, national_id, status, created_at, reminder_sent_at', { count: 'exact' })
      .eq('status', 'pending_approval')
      .order('created_at', { ascending: true })
      .range(from, to);
    if (error) throw error;

    return res.json({
      applications: (data || []).map(withOverdueFlag),
      page,
      pageSize,
      total: count || 0,
    });
  } catch (err) {
    logger.error('[brandAmbassador] listPendingBaApplications error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load pending applications.' });
  }
}

/** GET /api/brand-ambassadors?status=&page=&pageSize= - full roster, any status. */
async function listBrandAmbassadors(req, res) {
  try {
    const { status } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from('brand_ambassadors')
      .select(
        'id, ba_code, referral_code, full_name, email, phone, status, current_commission_percent, onboarded_at, offboarded_at, created_at',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(from, to);
    if (status) query = query.eq('status', status);

    const { data: bas, error, count } = await query;
    if (error) throw error;

    // Summary counts per BA (landlords onboarded, qualified-pending
    // payout) - SECTION B/C: sourced directly from `landlords` (ba_id
    // + ba_qualification_status) now, not ba_landlord_claims. A
    // single grouped query rather than N+1 per row.
    const ids = (bas || []).map((b) => b.id);
    let claimCounts = {};
    if (ids.length) {
      const { data: landlordRows, error: landlordsErr } = await supabase
        .from('landlords')
        .select('ba_id, ba_qualification_status')
        .in('ba_id', ids);
      if (landlordsErr) throw landlordsErr;
      claimCounts = (landlordRows || []).reduce((acc, l) => {
        acc[l.ba_id] = acc[l.ba_id] || { landlordsOnboarded: 0, qualifiedPendingPayout: 0 };
        acc[l.ba_id].landlordsOnboarded += 1;
        if (l.ba_qualification_status === 'qualified') acc[l.ba_id].qualifiedPendingPayout += 1;
        return acc;
      }, {});
    }

    // BUG FIX: '/signup' is not a real frontend route (only '/register'
    // is - see App.jsx) - anyone using the old link fell through the
    // catch-all straight to /login instead of the signup form. '/register'
    // already reads ?ref=CODE, auto-resolves it, and shows the referral banner.
    const referralBase = `${FRONTEND_URL}/register`;
    const brandAmbassadors = (bas || []).map((b) => ({
      ...b,
      referralLink: b.referral_code ? `${referralBase}?ref=${b.referral_code}` : null,
      landlordsOnboarded: claimCounts[b.id]?.landlordsOnboarded || 0,
      qualifiedPendingPayout: claimCounts[b.id]?.qualifiedPendingPayout || 0,
    }));

    return res.json({ brandAmbassadors, page, pageSize, total: count || 0 });
  } catch (err) {
    logger.error('[brandAmbassador] listBrandAmbassadors error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load Brand Ambassadors.' });
  }
}

// FIX (direct request: "offboard or activate an account should ask
// for the password, just like for landlords"): mirrors
// admin.controller.js's verifyAdminPassword - same env-var hash, same
// bcrypt compare. Every state-changing BA action below (suspend,
// reactivate, offboard, restore) now re-checks this before writing
// anything, instead of firing on a bare authenticated POST.
async function verifyAdminPassword(password) {
  const adminPasswordHash = process.env.SUPER_ADMIN_PASSWORD_HASH;
  if (!adminPasswordHash) return false;
  if (!password) return false;
  return comparePassword(password, adminPasswordHash);
}

/**
 * POST /api/brand-ambassadors/:id/suspend (admin-only)
 *
 * Reversible, for-cause pause: blocks login and new claim submissions
 * (see handleBrandAmbassadorLogin) but - per the Money & Data
 * Integrity Rules and Phase 10's qualification job - does NOT stop a
 * suspended BA's already-pending claims from qualifying normally, and
 * never touches referral_code, existing claims, or landlords.ba_id.
 * Deliberately separate from offboardBrandAmbassador below: 'suspended'
 * is reversible and admin-initiated for cause, 'inactive' is not.
 */
async function suspendBrandAmbassador(req, res) {
  try {
    const { id } = req.params;
    const { password } = req.body;
    const passwordOk = await verifyAdminPassword(password);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Incorrect admin password. Brand Ambassador was NOT suspended.' });
    }

    const { data: ba, error: findErr } = await supabase.from('brand_ambassadors').select('id, status').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!ba) return res.status(404).json({ error: 'Brand Ambassador not found.' });
    if (ba.status !== 'active') {
      return res.status(400).json({ error: `This Brand Ambassador is ${ba.status}, not active - only an active BA can be suspended.` });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('brand_ambassadors')
      .update({ status: 'suspended' })
      .eq('id', id)
      .select('id, full_name, status')
      .single();
    if (updateErr) throw updateErr;

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'ba_suspended', targetType: 'brand_ambassador', targetId: id });

    return res.json({ message: 'Brand Ambassador suspended.', brandAmbassador: updated });
  } catch (err) {
    logger.error('[brandAmbassador] suspendBrandAmbassador error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to suspend this Brand Ambassador.' });
  }
}

/**
 * POST /api/brand-ambassadors/:id/reactivate (admin-only)
 * Reverses suspend - the counterpart action that makes 'suspended'
 * meaningfully different from the permanent 'inactive' state below.
 */
async function reactivateBrandAmbassador(req, res) {
  try {
    const { id } = req.params;
    const { password } = req.body;
    const passwordOk = await verifyAdminPassword(password);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Incorrect admin password. Brand Ambassador was NOT reactivated.' });
    }

    const { data: ba, error: findErr } = await supabase.from('brand_ambassadors').select('id, status').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!ba) return res.status(404).json({ error: 'Brand Ambassador not found.' });
    if (ba.status !== 'suspended') {
      return res.status(400).json({ error: `This Brand Ambassador is ${ba.status}, not suspended - only a suspended BA can be reactivated.` });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('brand_ambassadors')
      .update({ status: 'active' })
      .eq('id', id)
      .select('id, full_name, status')
      .single();
    if (updateErr) throw updateErr;

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'ba_reactivated', targetType: 'brand_ambassador', targetId: id });

    return res.json({ message: 'Brand Ambassador reactivated.', brandAmbassador: updated });
  } catch (err) {
    logger.error('[brandAmbassador] reactivateBrandAmbassador error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to reactivate this Brand Ambassador.' });
  }
}

/**
 * POST /api/brand-ambassadors/:id/offboard (admin-only) - Phase 16.
 *
 * Permanent, one-way. Distinct from suspend above: a BA who has left
 * the program, recorded without breaking anything already earned.
 * Per the confirmed decision, explicitly does NOT touch:
 *   - referral_code (stays valid - new signups through it still set
 *     landlords.ba_id, exactly as before)
 *   - any existing ba_landlord_claims row or its qualification_status/
 *     payout_amount/commission_bonus_amount
 *   - landlords.ba_id on any landlord already linked to this BA
 * What it DOES change going forward: baQualification.job.js already
 * only qualifies claims for BAs with status IN ('active','suspended'),
 * so an inactive BA's pending claims simply stop accruing new
 * payouts from here on - no separate write needed for that here.
 * Reassignment of a landlord's ba_id to a different BA is deliberately
 * NOT built - see the build spec's note on this.
 */
async function offboardBrandAmbassador(req, res) {
  try {
    const { id } = req.params;
    const { password } = req.body;
    const passwordOk = await verifyAdminPassword(password);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Incorrect admin password. Brand Ambassador was NOT offboarded.' });
    }

    const { data: ba, error: findErr } = await supabase.from('brand_ambassadors').select('id, status').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!ba) return res.status(404).json({ error: 'Brand Ambassador not found.' });
    if (!['active', 'suspended'].includes(ba.status)) {
      return res.status(400).json({ error: `This Brand Ambassador is already ${ba.status} - only an active or suspended BA can be offboarded.` });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('brand_ambassadors')
      .update({ status: 'inactive', offboarded_at: new Date().toISOString(), offboarded_by_admin_id: req.user.id })
      .eq('id', id)
      .select('id, full_name, status, offboarded_at')
      .single();
    if (updateErr) throw updateErr;

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'ba_offboarded', targetType: 'brand_ambassador', targetId: id });

    return res.json({ message: 'Brand Ambassador offboarded. Their referral link keeps working.', brandAmbassador: updated });
  } catch (err) {
    logger.error('[brandAmbassador] offboardBrandAmbassador error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to offboard this Brand Ambassador.' });
  }
}

/**
 * POST /api/brand-ambassadors/:id/restore (admin-only)
 *
 * Reverses offboardBrandAmbassador above: brings an 'inactive' BA
 * back to 'active' so they can log in and start qualifying for new
 * payouts again. Clears offboarded_at/offboarded_by_admin_id so the
 * roster doesn't keep showing a stale offboard date for a BA who is
 * active again - a fresh offboard later will set them again. Does
 * NOT touch referral_code, existing claims, or landlords.ba_id, same
 * as offboard didn't.
 */
async function restoreBrandAmbassador(req, res) {
  try {
    const { id } = req.params;
    const { password } = req.body;
    const passwordOk = await verifyAdminPassword(password);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Incorrect admin password. Brand Ambassador was NOT restored.' });
    }

    const { data: ba, error: findErr } = await supabase.from('brand_ambassadors').select('id, status').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!ba) return res.status(404).json({ error: 'Brand Ambassador not found.' });
    if (ba.status !== 'inactive') {
      return res.status(400).json({ error: `This Brand Ambassador is ${ba.status}, not offboarded - only an offboarded (inactive) BA can be restored.` });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('brand_ambassadors')
      .update({ status: 'active', offboarded_at: null, offboarded_by_admin_id: null })
      .eq('id', id)
      .select('id, full_name, status')
      .single();
    if (updateErr) throw updateErr;

    logActivity({ actorType: 'admin', actorId: req.user.id, action: 'ba_restored', targetType: 'brand_ambassador', targetId: id });

    return res.json({ message: 'Brand Ambassador restored to active.', brandAmbassador: updated });
  } catch (err) {
    logger.error('[brandAmbassador] restoreBrandAmbassador error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to restore this Brand Ambassador.' });
  }
}

/**
 * SECTION D (consolidated instructions) - referral code format.
 * Old scheme #1: sequential "BA-0001", "BA-0002", ... - trivially
 * guessable/enumerable. Old scheme #2: `<NAME-SLUG>-<RANDOM5>` - still
 * leaked the BA's name into the code. Current scheme: a single fully
 * random token, e.g. "RPKHPOUJB" - no name, no sequence, nothing
 * derived from anything attacker- or admin-visible. Every BA gets one
 * unique code that no one else can ever hold.
 */
const RANDOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 0/O/1/I/L removed to avoid visual ambiguity
const RANDOM_CODE_LENGTH = 9;

function randomBaCode() {
  let out = '';
  for (let i = 0; i < RANDOM_CODE_LENGTH; i++) {
    out += RANDOM_CODE_ALPHABET[Math.floor(Math.random() * RANDOM_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Generates a random code and regenerates it on any uniqueness
 * collision against existing ba_code/referral_code values (both
 * columns are always set to the same value, so checking one checks
 * both). Bounded retry loop - a collision on a 9-char, 32-symbol
 * alphabet (32^9 ≈ 3.5 * 10^13 combinations) is already vanishingly
 * unlikely; the cap just guards against an infinite loop if something
 * is structurally wrong (e.g. the table itself is corrupted with
 * duplicates).
 */
async function generateBaCode() {
  const MAX_ATTEMPTS = 20;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = randomBaCode();
    const { data: existing, error } = await supabase
      .from('brand_ambassadors')
      .select('id')
      .eq('ba_code', candidate)
      .maybeSingle();
    if (error) throw error;
    if (!existing) return candidate;
  }
  throw new Error('Could not generate a unique BA referral code after multiple attempts.');
}

/** POST /api/brand-ambassadors/:id/approve (admin-only) */
async function approveBaApplication(req, res) {
  try {
    const { id } = req.params;
    const { data: application, error: findErr } = await supabase
      .from('brand_ambassadors')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!application) return res.status(404).json({ error: 'Application not found.' });
    if (application.status !== 'pending_approval') {
      return res.status(400).json({ error: `This application is already ${application.status}, not pending approval.` });
    }

    const baCode = await generateBaCode();
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    const { data: approved, error: updateErr } = await supabase
      .from('brand_ambassadors')
      .update({
        ba_code: baCode,
        referral_code: baCode,
        password_hash: passwordHash,
        must_change_password: true,
        status: 'active',
        onboarded_at: new Date().toISOString(),
        reviewed_by_admin_id: 'super-admin',
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    // Same '/signup' -> '/register' fix as referralBase above.
    const referralLink = `${FRONTEND_URL}/register?ref=${baCode}`;

    // Best-effort delivery - a failed SMS/email must never roll back
    // the approval itself (Money & Data Integrity Rules), so this is
    // fired after the update above has already committed.
    const message = `Welcome to RentaPay, ${application.full_name}! Your Brand Ambassador ID is ${baCode}. Your referral link: ${referralLink}. Temp password: ${tempPassword} (login with your phone/email; you'll be asked to change it).`;
    Promise.allSettled([
      sendSMS(application.phone, message),
      sendEmail(
        application.email,
        'Your RentaPay Brand Ambassador application was approved',
        wrapEmailHtml(message)
      ),
    ]).then((results) => {
      results.forEach((r) => {
        if (r.status === 'rejected') logger.error('[brandAmbassador] approveBaApplication: credential delivery failed:', r.reason?.message || r.reason);
      });
    });

    logActivity({
      actorType: 'admin',
      actorId: 'super-admin',
      action: 'ba_application_approved',
      targetType: 'brand_ambassador',
      targetId: approved.id,
      metadata: { baCode },
    });

    return res.json({
      message: 'Application approved. Credentials were sent to the applicant.',
      brandAmbassador: { ...approved, password_hash: undefined },
      // Fallback in case delivery fails - same convention as
      // addManager's tempCredentials return.
      tempCredentials: { baCode, referralLink, phone: application.phone, email: application.email, tempPassword },
    });
  } catch (err) {
    logger.error('[brandAmbassador] approveBaApplication error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to approve application.' });
  }
}

/** POST /api/brand-ambassadors/:id/reject (admin-only), body: { reason? } */
async function rejectBaApplication(req, res) {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data: application, error: findErr } = await supabase
      .from('brand_ambassadors')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!application) return res.status(404).json({ error: 'Application not found.' });
    if (application.status !== 'pending_approval') {
      return res.status(400).json({ error: `This application is already ${application.status}, not pending approval.` });
    }

    const { data: rejected, error: updateErr } = await supabase
      .from('brand_ambassadors')
      .update({
        status: 'rejected',
        rejected_reason: reason || null,
        reviewed_by_admin_id: 'super-admin',
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    // Does NOT delete the row (kept for audit history) and does NOT
    // block a future re-application - the partial unique indexes
    // exclude status = 'rejected', see Phase 1.
    sendEmail(
      application.email,
      'Your RentaPay Brand Ambassador application',
      wrapEmailHtml(
        `Thanks for your interest in becoming a RentaPay Brand Ambassador. Unfortunately your application wasn't approved at this time.${reason ? `\n\nReason: ${reason}` : ''}\n\nYou're welcome to apply again in the future.`
      )
    ).catch((emailErr) => {
      logger.error('[brandAmbassador] rejectBaApplication: notify email failed:', emailErr.message);
      captureException(emailErr);
    });

    logActivity({
      actorType: 'admin',
      actorId: 'super-admin',
      action: 'ba_application_rejected',
      targetType: 'brand_ambassador',
      targetId: rejected.id,
      reason: reason || undefined,
    });

    return res.json({ message: 'Application rejected.', brandAmbassador: { ...rejected, password_hash: undefined } });
  } catch (err) {
    logger.error('[brandAmbassador] rejectBaApplication error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to reject application.' });
  }
}

// ---------------------------------------------------------------------
// PHASE 3 - BA PORTAL SHELL
//
// The BA's own profile for the portal header/dashboard - referral
// code + link, name, current commission tier, etc. Scoped exactly like
// listMyClaims/getBaStats will be in later phases: the id comes ONLY
// from the authenticated JWT (req.user.id), never from a client-
// supplied param, per the Money & Data Integrity Rules ("a BA can only
// ever see their own data - enforced server-side").
// ---------------------------------------------------------------------
async function getMyBaProfile(req, res) {
  try {
    const { data: ba, error } = await supabase
      .from('brand_ambassadors')
      .select('id, ba_code, referral_code, full_name, email, phone, status, current_commission_percent, leaderboard_opt_in, must_change_password, onboarded_at, photo_url')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!ba) return res.status(404).json({ error: 'Brand Ambassador profile not found.' });

    const referralBase = process.env.PUBLIC_SIGNUP_URL || 'https://rentapay.co.ke/register';
    return res.json({
      ...ba,
      referralLink: ba.referral_code ? `${referralBase}?ref=${ba.referral_code}` : null,
    });
  } catch (err) {
    logger.error('[brandAmbassador] getMyBaProfile error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load your Brand Ambassador profile.' });
  }
}

// ---------------------------------------------------------------------
// PHASE 6 - BA Portal: Settings & Profile.
//
// Contact-detail editing for the logged-in BA. Full name is editable
// here; phone/email are NOT (item 5 fix) - the portal form now shows
// them pre-filled and read-only, and this endpoint enforces that same
// rule server-side rather than trusting the frontend alone, since a
// direct API call could otherwise still slip a phone/email change
// through with none of the identity verification that's supposed to
// gate it. There is no self-service verified-change flow yet; a BA
// who genuinely needs their phone/email changed goes through Support
// (see the "Contact Support" hint next to this form and the new Help
// section), who can update it via an admin-side tool once identity is
// confirmed. Scoped to req.user.id only, same as every other
// BA-authenticated endpoint.
// ---------------------------------------------------------------------
async function updateMyProfile(req, res) {
  try {
    const baId = req.user.id;
    const { fullName, phone, email } = req.body;

    const { data: ba, error: findErr } = await supabase
      .from('brand_ambassadors')
      .select('id, full_name, phone, email')
      .eq('id', baId)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!ba) return res.status(404).json({ error: 'Brand Ambassador profile not found.' });

    // Reject an actual change to phone/email outright (not just
    // ignore it) so a caller gets a clear, honest error instead of a
    // silent no-op that looks like it might have worked.
    if (phone !== undefined) {
      let normalizedPhone;
      try {
        normalizedPhone = normalizePhoneOrThrow(phone, 'Phone number');
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
      if (normalizedPhone !== ba.phone) {
        return res.status(400).json({ error: 'Phone number can\'t be changed here. Please contact Support to update it.' });
      }
    }

    if (email !== undefined) {
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
      const normalizedEmail = String(email).trim().toLowerCase();
      if (normalizedEmail !== ba.email) {
        return res.status(400).json({ error: 'Email address can\'t be changed here. Please contact Support to update it.' });
      }
    }

    const updates = {};

    if (fullName !== undefined && fullName !== ba.full_name) {
      if (!String(fullName).trim()) return res.status(400).json({ error: 'Full name cannot be empty.' });
      updates.full_name = String(fullName).trim();
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ message: 'No changes to save.' });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('brand_ambassadors')
      .update(updates)
      .eq('id', baId)
      .select('id, ba_code, referral_code, full_name, email, phone, status, current_commission_percent, leaderboard_opt_in, must_change_password, onboarded_at, photo_url')
      .single();
    if (updateErr) throw updateErr;

    logActivity({ actorType: 'brand_ambassador', actorId: baId, action: 'ba_profile_updated', targetType: 'brand_ambassador', targetId: baId, metadata: { fields: Object.keys(updates) } });

    return res.json({ ...updated, message: 'Profile updated.' });
  } catch (err) {
    logger.error('[brandAmbassador] updateMyProfile error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update your profile.' });
  }
}

// PHASE 6 - "Show me on the leaderboard" opt-in toggle (Phase 18 wires
// up the actual leaderboard view; this just persists the preference).
async function updateLeaderboardOptIn(req, res) {
  try {
    const baId = req.user.id;
    const { optIn } = req.body;
    if (typeof optIn !== 'boolean') return res.status(400).json({ error: 'optIn must be true or false.' });

    const { error } = await supabase.from('brand_ambassadors').update({ leaderboard_opt_in: optIn }).eq('id', baId);
    if (error) throw error;

    return res.json({ leaderboard_opt_in: optIn });
  } catch (err) {
    logger.error('[brandAmbassador] updateLeaderboardOptIn error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update leaderboard preference.' });
  }
}

// PHASE 4 - PUBLIC: resolves a ?ref=<code> code to a display name only
// (never phone/email/internal id) so the landlord signup form can show
// "Referred by <name>" before the account exists. Only ever matches an
// 'active' BA.
//
// SECTION D (consolidated instructions): "no code provided" and "code
// provided but doesn't exist/isn't active" are now distinguishable via
// `reason`, so the frontend can tell the two apart - a blank field
// should never show an error, but a typo'd code the landlord actually
// typed in should. The link-based (?ref=) flow only ever hits the "no
// code" case as an initial state, never surfaces the not-found error to
// the person (see D's "fail silently" note for link-based referrals,
// unchanged from before) - that message is for the manual-entry path.
async function resolveReferralCode(req, res) {
  try {
    const { code } = req.params;
    if (!code || !code.trim()) return res.json({ matched: false, reason: 'no_code' });
    const { data: ba } = await supabase
      .from('brand_ambassadors')
      .select('full_name, status')
      .eq('referral_code', code.trim())
      .maybeSingle();
    if (!ba || ba.status !== 'active') return res.json({ matched: false, reason: 'not_found' });
    return res.json({ matched: true, fullName: ba.full_name });
  } catch (err) {
    logger.error('[brandAmbassador] resolveReferralCode error:', err.message);
    captureException(err);
    return res.json({ matched: false, reason: 'not_found' });
  }
}

// ---------------------------------------------------------------------
// SECTION A (consolidated instructions) - manual claim logging
// (submitLandlordClaim / listMyClaims / editMyClaim) has been removed
// entirely, along with the ba_landlord_claims table. A landlord is
// attached to a BA ONLY via the referral link/code at signup
// (landlords.ba_id, set in auth.controller.js's registerLandlord) -
// there is no fallback path and no way to retroactively assign one.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// SECTION B - "My Onboarded Landlords" is now the ONE single live
// list, sourced directly from `landlords` filtered by ba_id, joined
// against the qualification columns added directly onto `landlords`
// (ba_qualification_status / ba_qualified_at - see Section C and
// 2026-08-remove-manual-ba-claims.sql). There is no more dual "auto-
// linked vs manually-logged" split and no ba_landlord_claims lookup -
// landlords.ba_id is the only source of truth, set exactly once, at
// signup, via the referral link/code.
// ---------------------------------------------------------------------
async function listMyOnboardedLandlords(req, res) {
  try {
    const baId = req.user.id;
    const { from, to } = req.query;

    let query = supabase
      .from('landlords')
      .select('id, full_name, phone, email, county, constituency, subscription_status, ba_qualification_status, ba_qualified_at, created_at')
      .eq('ba_id', baId)
      .order('created_at', { ascending: false });

    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data: landlordRows, error } = await query;
    if (error) throw error;

    const landlords = (landlordRows || []).map((l) => ({
      id: l.id,
      fullName: l.full_name,
      // Masked middle digits (e.g. 254***325966) - same
      // maskPhoneMiddle utility/style used everywhere else this
      // convention appears.
      phone: maskPhoneMiddle(l.phone),
      email: l.email,
      location: [l.constituency, l.county].filter(Boolean).join(', ') || null,
      subscriptionStatus: l.subscription_status,
      qualificationStatus: l.ba_qualification_status || 'pending',
      qualifiedAt: l.ba_qualified_at,
      onboardedAt: l.created_at,
    }));
    return res.json({ landlords });
  } catch (err) {
    logger.error('[brandAmbassador] listMyOnboardedLandlords error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load your onboarded landlords.' });
  }
}

// ---------------------------------------------------------------------
// PHASE 7 - Sharing: WhatsApp Deep Link & In-App to Admin.
//
// Builds ONE plain-text summary of the BA's own live onboarded-
// landlords list (Section B) for a selected date/range (name, phone,
// qualification status per landlord, plus a total count) and delivers
// it to admin two ways at once, not as a choice between them:
//   1. Returns the summary text to the frontend so it can open a
//      wa.me deep link (src/utils/whatsapp.js) pre-filled with it.
//   2. Posts the SAME text into the existing admin notifications
//      inbox via notify.service.js (recipientType 'admin',
//      recipientId 'super-admin' - the same mechanism every other
//      admin-facing in-app notification already uses, e.g.
//      2026-07-admin-notifications-support.sql). No parallel
//      messaging system is built for this.
//
// Scoped server-side to req.user.id, same as listMyOnboardedLandlords
// - a BA can only ever report on their own landlords.
//
// PHASE 20 - the full report text below always lands as its own,
// untouched notifications row immediately (never batched, never
// summarized) - only the real-time PING that tells admin "something
// just arrived" is batched, via queueBatchedNotification, so several
// BAs reporting in the same short window produce one grouped push
// ("3 new BA reports - check your inbox") instead of a flood. See
// notificationBatch.service.js and notificationBatchFlush.job.js.
// ---------------------------------------------------------------------
const SHARE_REPORT_MAX_LISTED_LANDLORDS = 50;

function formatLandlordLine(l, index) {
  return `${index + 1}. ${l.full_name} — ${l.phone} — ${l.ba_qualification_status || 'pending'}`;
}

function buildOnboardedLandlordsReportSummary(ba, landlords, { from, to } = {}) {
  const periodLabel = from || to ? `${from ? from.slice(0, 10) : '…'} to ${to ? to.slice(0, 10) : '…'}` : 'all time';
  const lines = landlords.slice(0, SHARE_REPORT_MAX_LISTED_LANDLORDS).map(formatLandlordLine);
  const overflow = landlords.length - lines.length;

  const header = `BA report from ${ba.full_name}${ba.ba_code ? ` (${ba.ba_code})` : ''} — ${periodLabel}`;
  const body = [header, '', ...lines];
  if (overflow > 0) body.push(`…and ${overflow} more (full list in admin inbox).`);
  body.push('', `Total: ${landlords.length} landlord${landlords.length === 1 ? '' : 's'}`);

  return body.join('\n');
}

async function shareClaimsReport(req, res) {
  try {
    const baId = req.user.id;
    const { from, to } = req.body || {};

    const { data: ba, error: baErr } = await supabase
      .from('brand_ambassadors')
      .select('id, full_name, ba_code')
      .eq('id', baId)
      .maybeSingle();
    if (baErr) throw baErr;
    if (!ba) return res.status(404).json({ error: 'Brand Ambassador profile not found.' });

    let query = supabase
      .from('landlords')
      .select('full_name, phone, ba_qualification_status, created_at')
      .eq('ba_id', baId)
      .order('created_at', { ascending: false });
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data: landlords, error: landlordsErr } = await query;
    if (landlordsErr) throw landlordsErr;

    if (!landlords || landlords.length === 0) {
      return res.status(400).json({ error: 'No onboarded landlords in this period to share.' });
    }

    const summary = buildOnboardedLandlordsReportSummary(ba, landlords, { from, to });

    // Best-effort, same as every other notify() call site - a hiccup
    // here shouldn't stop the BA from still sending it themselves via
    // the WhatsApp link the response hands back. The full report body
    // always lands in the admin inbox immediately and unbatched
    // (urgent: false - the real-time push for this is handled
    // separately below, batched, so admin isn't pinged twice for one
    // report).
    try {
      await notify('admin', 'super-admin', null, summary, {
        title: `BA report: ${ba.full_name} (${landlords.length} landlord${landlords.length === 1 ? '' : 's'})`,
        category: 'ba_report',
        urgent: false,
      });
    } catch (notifyErr) {
      logger.error('[brandAmbassador] shareClaimsReport admin notify failed:', notifyErr.message);
      captureException(notifyErr);
    }

    // PHASE 20 - batch the real-time ping (push alert only) so admin
    // isn't flooded when several BAs report within the same short
    // window. This never touches or duplicates the report content
    // written immediately above - a lone report still pings admin
    // right away, exactly as it did before this phase existed.
    try {
      await queueBatchedNotification(
        {
          recipientType: 'admin',
          recipientId: 'super-admin',
          batchKey: 'admin_ba_report_ping',
          eventType: 'ba_report',
          fragment: ba.full_name,
          metadata: { baId, count: landlords.length },
        },
        () =>
          sendPushToRecipient('admin', 'super-admin', {
            title: 'New BA report',
            body: `New BA report from ${ba.full_name} - check your inbox.`,
          })
      );
    } catch (batchErr) {
      logger.error('[brandAmbassador] shareClaimsReport ping batching failed:', batchErr.message);
      captureException(batchErr);
    }

    return res.json({ summary, count: landlords.length });
  } catch (err) {
    logger.error('[brandAmbassador] shareClaimsReport error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to share your report.' });
  }
}

// ---------------------------------------------------------------------
// PHASE 5 - BA Portal: Dashboard, My Landlords, Stats.
//
// Powers the Dashboard cards, the trend chart, and the Stats section's
// weekly/monthly rollups from ONE grouped read. This codebase has no
// supabase.rpc()/raw-SQL grouping precedent anywhere else in the
// controllers (grep confirms it - grouping is always done in JS after
// a single select), so this follows the same convention: one bounded
// query (last 180 days of this BA's own claims, indexed on
// (ba_id, created_at desc) per the Phase 1 migration) fetched once,
// then grouped in memory - never a query per day/week/month.
//
// Scoped to req.user.id only (see Money & Data Integrity Rules - "a
// BA can only ever see their own data"); never accepts a BA id from
// the client.
// ---------------------------------------------------------------------

const STATS_WINDOW_DAYS = 180;

function dayKey(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function startOfWeek(d) {
  // Monday-start week, matching how the rest of the app's "this week"
  // reporting is framed for the Kenyan market (see overdue.js).
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay(); // 0 = Sun
  const diff = (day === 0 ? -6 : 1) - day;
  copy.setUTCDate(copy.getUTCDate() + diff);
  return copy;
}

function weekKey(d) {
  return dayKey(startOfWeek(d));
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getBaStats(req, res) {
  try {
    const baId = req.user.id;

    const windowStart = new Date();
    windowStart.setUTCDate(windowStart.getUTCDate() - STATS_WINDOW_DAYS);

    const [{ data: ba, error: baErr }, { data: landlordRows, error: landlordsErr }] = await Promise.all([
      supabase
        .from('brand_ambassadors')
        .select('id, current_commission_percent')
        .eq('id', baId)
        .maybeSingle(),
      // SECTION B/C: onboarding counts/trend AND qualification status
      // both come LIVE from `landlords` now - ba_id (set the instant a
      // landlord signs up via this BA's referral link/code) and
      // ba_qualification_status (set by the qualification job, see
      // Section C / baQualification.job.js). No separate claims table
      // to join against anymore.
      supabase
        .from('landlords')
        .select('id, created_at, ba_qualification_status')
        .eq('ba_id', baId)
        .gte('created_at', windowStart.toISOString())
        .order('created_at', { ascending: true }),
    ]);
    if (baErr) throw baErr;
    if (landlordsErr) throw landlordsErr;

    const landlordsInWindow = landlordRows || [];
    const qualifiedRows = landlordsInWindow.filter((l) => l.ba_qualification_status === 'qualified');

    const now = new Date();
    const todayKey = dayKey(now);
    const thisWeekKey = weekKey(now);
    const thisMonthKey = monthKey(now);

    let onboardedToday = 0;
    let onboardedThisWeek = 0;
    let onboardedThisMonth = 0;
    const qualifiedCount = qualifiedRows.length;

    const byDay = new Map(); // last 14 days, for the dashboard trend chart
    const byWeek = new Map(); // last 8 weeks, for the Stats section
    const byMonth = new Map(); // last 6 months, for the Stats section

    for (const l of landlordsInWindow) {
      const created = new Date(l.created_at);
      const dKey = dayKey(created);
      const wKey = weekKey(created);
      const mKey = monthKey(created);

      if (dKey === todayKey) onboardedToday += 1;
      if (wKey === thisWeekKey) onboardedThisWeek += 1;
      if (mKey === thisMonthKey) onboardedThisMonth += 1;

      byDay.set(dKey, (byDay.get(dKey) || 0) + 1);
      byWeek.set(wKey, (byWeek.get(wKey) || 0) + 1);
      byMonth.set(mKey, (byMonth.get(mKey) || 0) + 1);
    }

    // Last 14 days, oldest -> newest, zero-filled.
    const trend = [];
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const key = dayKey(d);
      trend.push({ label: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), value: byDay.get(key) || 0 });
    }

    // Last 8 weeks, oldest -> newest, zero-filled.
    const weeklyRollup = [];
    for (let i = 7; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i * 7);
      const weekStart = startOfWeek(d);
      const key = dayKey(weekStart);
      weeklyRollup.push({ label: weekStart.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), value: byWeek.get(key) || 0 });
    }

    // Last 6 months, oldest -> newest, zero-filled.
    const monthlyRollup = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = monthKey(d);
      monthlyRollup.push({ label: d.toLocaleDateString('en-GB', { month: 'short' }), value: byMonth.get(key) || 0 });
    }

    const totalMatched = landlordsInWindow.length;
    const qualificationRate = totalMatched > 0 ? Math.round((qualifiedCount / totalMatched) * 1000) / 10 : 0;

    // SECTION E: commission is now a recurring percentage of each
    // qualifying landlord's actual payment, not a milestone ladder -
    // commission_tiers no longer exists. currentCommissionPercent here
    // is the rate that would apply to a payment landing right now
    // (BA override, if one exists, otherwise the global rate) -
    // resolveApplicableRate is the exact same lookup the payment path
    // itself uses, so this always matches reality.
    let currentCommissionPercent = 0;
    let thisMonthCommissionEarned = 0;
    let lifetimeCommissionEarned = 0;
    try {
      const rate = await resolveApplicableRate(baId, new Date());
      currentCommissionPercent = rate ? rate.percentage : 0;

      const cycle = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      const [{ data: monthRows }, { data: lifetimeRows }] = await Promise.all([
        supabase.from('ba_commission_earnings').select('commission_amount').eq('ba_id', baId).eq('billing_cycle', cycle),
        supabase.from('ba_commission_earnings').select('commission_amount').eq('ba_id', baId),
      ]);
      thisMonthCommissionEarned = (monthRows || []).reduce((sum, r) => sum + Number(r.commission_amount || 0), 0);
      lifetimeCommissionEarned = (lifetimeRows || []).reduce((sum, r) => sum + Number(r.commission_amount || 0), 0);
    } catch (rateErr) {
      logger.warn('[brandAmbassador] getBaStats: commission rate/earnings lookup skipped:', rateErr.message);
    }

    return res.json({
      onboardedToday,
      onboardedThisWeek,
      onboardedThisMonth,
      qualifiedCount,
      qualificationRate,
      currentCommissionPercent,
      thisMonthCommissionEarned,
      lifetimeCommissionEarned,
      trend,
      weeklyRollup,
      monthlyRollup,
    });
  } catch (err) {
    logger.error('[brandAmbassador] getBaStats error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load your stats.' });
  }
}

// ---------------------------------------------------------------------
// PHASE 18 - Optional BA Leaderboard.
//
// Opt-in only (leaderboard_opt_in, toggled via updateLeaderboardOptIn
// above) and deliberately excludes any KES figure - ranking signal
// only (qualified-landlord count + current tier badge), never
// payout_amount/commission_bonus_amount. Ranked over a selectable
// period: 'month' (calendar month to date), 'quarter' (calendar
// quarter to date), or 'all' (all-time, no date filter).
//
// The requesting BA always gets their own exact rank back, computed
// against every active BA regardless of opt-in - but they only ever
// appear in the `leaderboard` array itself (what other BAs would see)
// if they are both active AND opted in themselves.
// ---------------------------------------------------------------------

function quarterStart(d) {
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
}

function leaderboardPeriodStart(period, now) {
  if (period === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (period === 'quarter') return quarterStart(now);
  return null; // 'all' - no lower bound
}

// "Jane D." - never the full surname, and never contact info.
function displayNameFor(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Brand Ambassador';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

async function getLeaderboard(req, res) {
  try {
    const myId = req.user.id;
    const period = ['month', 'quarter', 'all'].includes(req.query.period) ? req.query.period : 'month';
    const periodStart = leaderboardPeriodStart(period, new Date());

    const { data: bas, error: baErr } = await supabase
      .from('brand_ambassadors')
      .select('id, full_name, status, leaderboard_opt_in, current_commission_percent')
      .eq('status', 'active');
    if (baErr) throw baErr;

    const activeBas = bas || [];
    const activeIds = activeBas.map((b) => b.id);

    // SECTION B/C: qualified counts now come straight from
    // `landlords` (ba_id + ba_qualification_status/ba_qualified_at) -
    // no more ba_landlord_claims join.
    let qualifiedQuery = supabase
      .from('landlords')
      .select('ba_id, ba_qualification_status, ba_qualified_at')
      .in('ba_id', activeIds.length ? activeIds : ['00000000-0000-0000-0000-000000000000'])
      .eq('ba_qualification_status', 'qualified');
    if (periodStart) qualifiedQuery = qualifiedQuery.gte('ba_qualified_at', periodStart.toISOString());
    const { data: qualifiedLandlords, error: qualifiedErr } = await qualifiedQuery;
    if (qualifiedErr) throw qualifiedErr;

    const countByBa = new Map();
    for (const l of qualifiedLandlords || []) {
      countByBa.set(l.ba_id, (countByBa.get(l.ba_id) || 0) + 1);
    }

    // Full ranking across every active BA (opted-in or not) - this is
    // what "my exact rank" is computed against, even though only the
    // opted-in subset is ever exposed to other BAs.
    const ranked = activeBas
      .map((b) => ({ ...b, qualifiedCount: countByBa.get(b.id) || 0 }))
      .sort((a, b) => b.qualifiedCount - a.qualifiedCount || a.full_name.localeCompare(b.full_name));

    let myRank = null;
    ranked.forEach((b, i) => {
      if (b.id === myId) myRank = { rank: i + 1, qualifiedCount: b.qualifiedCount, totalActiveBAs: ranked.length };
    });

    const leaderboard = ranked
      .filter((b) => b.leaderboard_opt_in)
      .map((b, i) => ({
        rank: i + 1,
        displayName: displayNameFor(b.full_name),
        qualifiedCount: b.qualifiedCount,
        currentCommissionPercent: b.current_commission_percent || 0,
        isMe: b.id === myId,
      }));

    return res.json({ period, leaderboard, myRank });
  } catch (err) {
    logger.error('[brandAmbassador] getLeaderboard error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the leaderboard.' });
  }
}

// ---------------------------------------------------------------------
// SECTION E - the BA's own recurring commission earnings, one row per
// completed landlord subscription payment (ba_commission_earnings).
// Scoped server-side to req.user.id, never a client-supplied BA id -
// same convention as every other /me/* route in this file. Optional
// ?cycle=YYYY-MM filters to one billing cycle; otherwise the most
// recent 100 rows across all cycles.
// ---------------------------------------------------------------------
async function getMyCommissionEarnings(req, res) {
  try {
    const baId = req.user.id;
    const { cycle } = req.query;

    let query = supabase
      .from('ba_commission_earnings')
      .select('id, landlord_id, payment_amount, percentage_applied, commission_amount, billing_cycle, paid_at, landlords(full_name)')
      .eq('ba_id', baId)
      .order('paid_at', { ascending: false })
      .limit(100);
    if (cycle) query = query.eq('billing_cycle', cycle);

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data || []).map((r) => ({
      id: r.id,
      landlordName: r.landlords?.full_name || 'Former landlord',
      paymentAmount: Number(r.payment_amount),
      percentageApplied: Number(r.percentage_applied),
      commissionAmount: Number(r.commission_amount),
      billingCycle: r.billing_cycle,
      paidAt: r.paid_at,
    }));

    const total = rows.reduce((sum, r) => sum + r.commissionAmount, 0);

    return res.json({ earnings: rows, total });
  } catch (err) {
    logger.error('[brandAmbassador] getMyCommissionEarnings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load your commission earnings.' });
  }
}

module.exports = {
  requestBaEmailVerification,
  confirmBaEmailVerification,
  submitBaOnboarding,
  validateBaOnboardingLinkToken,
  getBaOnboardingLinkStatus,
  generateBaOnboardingLink,
  listPendingBaApplications,
  listBrandAmbassadors,
  approveBaApplication,
  rejectBaApplication,
  suspendBrandAmbassador,
  reactivateBrandAmbassador,
  offboardBrandAmbassador,
  restoreBrandAmbassador,
  getMyBaProfile,
  updateMyProfile,
  updateLeaderboardOptIn,
  resolveReferralCode,
  listMyOnboardedLandlords,
  shareClaimsReport,
  getBaStats,
  getLeaderboard,
  getMyCommissionEarnings,
  REMINDER_THRESHOLD_HOURS,
};
