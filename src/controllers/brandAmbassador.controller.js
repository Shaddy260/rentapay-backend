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
const { hashPassword } = require('../utils/password');
const { generateOTP, getEmailVerificationOTPExpiry, isOTPExpired } = require('../utils/otp');
const { normalizePhoneOrThrow } = require('../utils/phone');
const { isValidEmail } = require('../utils/email');
const { findPhoneConflict } = require('../utils/phoneUniqueness');
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

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rentapay.co.ke';

// ---------------------------------------------------------------------
// PUBLIC - step 1: send a code to the email the applicant typed.
// Deliberately does NOT touch brand_ambassadors at all - the person
// hasn't submitted anything yet, this only proves they control the
// address before they're allowed to.
// ---------------------------------------------------------------------
async function requestBaEmailVerification(req, res) {
  try {
    const { email } = req.body;
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
    const { fullName, emailVerification, termsAccepted } = req.body;
    let { phone, email } = req.body;

    const required = { fullName, phone, email };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) return res.status(400).json({ error: `Please fill in: ${missing.join(', ')}` });

    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    email = String(email).trim().toLowerCase();

    try {
      phone = normalizePhoneOrThrow(phone, 'Phone number');
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
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
          error: 'This phone number or email address was just registered by another application. Please check your details.',
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
          `${fullName} applied to become a Brand Ambassador.\n\nPhone: ${phone}\nEmail: ${email}\n\nReview it in the admin portal under Brand Ambassador Applications.`
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
      .select('id, full_name, email, phone, status, created_at, reminder_sent_at', { count: 'exact' })
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
    // payout) - only meaningful for active/suspended/inactive BAs
    // (i.e. anyone with an id claims could actually be tied to); a
    // single grouped query rather than N+1 per row.
    const ids = (bas || []).map((b) => b.id);
    let claimCounts = {};
    if (ids.length) {
      const { data: claims, error: claimsErr } = await supabase
        .from('ba_landlord_claims')
        .select('ba_id, match_status, qualification_status')
        .in('ba_id', ids);
      if (claimsErr) throw claimsErr;
      claimCounts = (claims || []).reduce((acc, c) => {
        acc[c.ba_id] = acc[c.ba_id] || { landlordsOnboarded: 0, qualifiedPendingPayout: 0 };
        if (c.match_status === 'matched') acc[c.ba_id].landlordsOnboarded += 1;
        if (c.qualification_status === 'qualified') acc[c.ba_id].qualifiedPendingPayout += 1;
        return acc;
      }, {});
    }

    const referralBase = `${FRONTEND_URL}/signup`;
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
 * Next sequential "BA-0001" code - same simple max+1 lookup pattern
 * used for unit payment codes (unit.controller.js) - gapless because
 * a code is only ever assigned here, at approval, never pre-reserved.
 */
async function getNextBaCode() {
  const { data, error } = await supabase
    .from('brand_ambassadors')
    .select('ba_code')
    .not('ba_code', 'is', null);
  if (error) throw error;

  let maxNumber = 0;
  for (const row of data || []) {
    const match = /^BA-(\d+)$/.exec(row.ba_code || '');
    if (match) maxNumber = Math.max(maxNumber, parseInt(match[1], 10));
  }
  return `BA-${String(maxNumber + 1).padStart(4, '0')}`;
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

    const baCode = await getNextBaCode();
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

    const referralLink = `${FRONTEND_URL}/signup?ref=${baCode}`;

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
// Contact-detail editing for the logged-in BA - same validation shape
// already used for tenant contact-detail edits (tenant.controller.js):
// normalize the phone, only run the GLOBAL phone/email uniqueness
// check (findPhoneConflict/findEmailConflict, extended in Phase 2 to
// cover brand_ambassadors) when the value is actually changing, since
// otherwise a BA saving their own unchanged phone/email would trip a
// false "already registered" conflict against their own row. Scoped
// to req.user.id only, same as every other BA-authenticated endpoint.
// ---------------------------------------------------------------------
async function updateMyProfile(req, res) {
  try {
    const baId = req.user.id;
    const { fullName } = req.body;
    let { phone, email } = req.body;

    const { data: ba, error: findErr } = await supabase
      .from('brand_ambassadors')
      .select('id, full_name, phone, email')
      .eq('id', baId)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!ba) return res.status(404).json({ error: 'Brand Ambassador profile not found.' });

    const updates = {};

    if (fullName !== undefined && fullName !== ba.full_name) {
      if (!String(fullName).trim()) return res.status(400).json({ error: 'Full name cannot be empty.' });
      updates.full_name = String(fullName).trim();
    }

    if (phone !== undefined) {
      try {
        phone = normalizePhoneOrThrow(phone, 'Phone number');
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
      if (phone !== ba.phone) {
        const phoneConflict = await findPhoneConflict(phone, 'brand_ambassador');
        if (phoneConflict) return res.status(409).json({ error: phoneConflict });
        updates.phone = phone;
      }
    }

    if (email !== undefined) {
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
      email = String(email).trim().toLowerCase();
      if (email !== ba.email) {
        const emailConflict = await findEmailConflict(email, 'brand_ambassador');
        if (emailConflict) return res.status(409).json({ error: emailConflict });
        updates.email = email;
      }
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

// PHASE 4 - PUBLIC: resolves a ?ref=BA-XXXX code to a display name only
// (never phone/email/internal id) so the landlord signup form can show
// "Referred by <name>" before the account exists. Only ever matches an
// 'active' BA - a typo'd/expired/rejected code returns matched: false,
// same "fail silently, never block signup" rule as the actual tagging
// in registerLandlord.
async function resolveReferralCode(req, res) {
  try {
    const { code } = req.params;
    if (!code) return res.json({ matched: false });
    const { data: ba } = await supabase
      .from('brand_ambassadors')
      .select('full_name, status')
      .eq('referral_code', code.trim())
      .maybeSingle();
    if (!ba || ba.status !== 'active') return res.json({ matched: false });
    return res.json({ matched: true, fullName: ba.full_name });
  } catch (err) {
    logger.error('[brandAmbassador] resolveReferralCode error:', err.message);
    captureException(err);
    return res.json({ matched: false });
  }
}

// ---------------------------------------------------------------------
// PHASE 4 - BA logs a landlord claim (Part B). Phone-match against the
// real landlords table is the authoritative signal (landlord phones
// are already globally unique per phoneUniqueness.js) - no fuzzy
// matching, no ba_landlord_claims row created unless a real account is
// found. See Phase 15 for the three unmatched-message variants.
// ---------------------------------------------------------------------
async function submitLandlordClaim(req, res) {
  try {
    const baId = req.user.id;
    let { fullName, phone, location } = req.body;

    if (!fullName || !phone) {
      return res.status(400).json({ error: 'fullName and phone are required.' });
    }
    fullName = String(fullName).trim();
    location = location ? String(location).trim() : null;

    try {
      phone = normalizePhoneOrThrow(phone, 'Phone number');
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    // Authoritative match: an active, real landlord account with this
    // exact normalized phone number.
    const { data: landlord, error: landlordErr } = await supabase
      .from('landlords')
      .select('id, full_name, phone, location, county, subscription_status, ba_id')
      .eq('phone', phone)
      .maybeSingle();
    if (landlordErr) throw landlordErr;

    if (!landlord) {
      // PHASE 15 - two read-only checks purely to pick the clearest of
      // three message variants. Neither check creates/modifies/saves
      // anything.
      let message =
        "We couldn't find a registered landlord with that phone number. Have them complete registration using your referral link, then try again.";

      const { data: lead } = await supabase
        .from('landlord_leads')
        .select('id, status')
        .eq('phone', phone)
        .in('status', ['new', 'contacted'])
        .maybeSingle();

      if (lead) {
        message =
          "This landlord's registration is still pending - they've been noted as interested but haven't completed signup yet. Have them finish registering on your referral link.";
      } else {
        // Near-miss check: same digits under a looser normalization
        // (strip everything but digits, compare last 9) - if
        // normalizePhoneOrThrow already collapsed the format
        // difference away, this simply finds nothing extra to add,
        // which is fine per the spec.
        const looseDigits = String(phone).replace(/\D/g, '').slice(-9);
        if (looseDigits.length === 9) {
          const { data: nearMiss } = await supabase
            .from('landlords')
            .select('id')
            .like('phone', `%${looseDigits}`)
            .neq('phone', phone)
            .maybeSingle();
          if (nearMiss) {
            message = "We couldn't find an exact match - double check the phone number format and try again.";
          }
        }
      }

      return res.status(200).json({ matched: false, message });
    }

    // A real account exists. If it's already tied to a DIFFERENT BA,
    // surface a clear conflict instead of silently reassigning credit.
    // PHASE 11 - this attempt is still logged as a claim row (match_
    // status 'conflict', never 'matched') rather than just returning
    // the 409 and vanishing, so the cross-BA security report's
    // duplicatePhoneAttempts signal has the full attempt history, not
    // just the winning claim.
    if (landlord.ba_id && landlord.ba_id !== baId) {
      const { data: conflictClaim, error: conflictErr } = await supabase
        .from('ba_landlord_claims')
        .insert({
          ba_id: baId,
          submitted_name: fullName,
          submitted_phone: phone,
          submitted_location: location,
          match_status: 'conflict',
          matched_landlord_id: landlord.id,
          matched_at: new Date().toISOString(),
          referred_at_signup: false,
        })
        .select()
        .single();
      if (conflictErr) {
        logger.error('[brandAmbassador] submitLandlordClaim: failed to log conflict attempt:', conflictErr.message);
        captureException(conflictErr);
      }

      logActivity({
        actorType: 'brand_ambassador',
        actorId: baId,
        action: 'ba_landlord_claim_conflict',
        targetType: 'landlord',
        targetId: landlord.id,
        metadata: { conflictWithBaId: landlord.ba_id, claimId: conflictClaim?.id || null },
      });

      return res.status(409).json({
        matched: false,
        conflict: true,
        message: 'This landlord is already linked to another ambassador.',
      });
    }

    // referred_at_signup = true only when landlords.ba_id was ALREADY
    // set to this same BA at registration time (Part A, the normal
    // case now via the referral link) - false when the match is found
    // via this phone-lookup path without a prior referral tag (still a
    // valid claim, just a lighter audit flag later per Phase 11).
    const referredAtSignup = landlord.ba_id === baId;

    if (!landlord.ba_id) {
      const { error: tagErr } = await supabase.from('landlords').update({ ba_id: baId }).eq('id', landlord.id);
      if (tagErr) throw tagErr;
    }

    const { data: claim, error: claimErr } = await supabase
      .from('ba_landlord_claims')
      .insert({
        ba_id: baId,
        submitted_name: fullName,
        submitted_phone: phone,
        submitted_location: location,
        match_status: 'matched',
        matched_landlord_id: landlord.id,
        matched_at: new Date().toISOString(),
        referred_at_signup: referredAtSignup,
      })
      .select()
      .single();
    if (claimErr) throw claimErr;

    const { count: unitsCount } = await supabase
      .from('units')
      .select('id', { count: 'exact', head: true })
      .eq('landlord_id', landlord.id);

    logActivity({
      actorType: 'brand_ambassador',
      actorId: baId,
      action: 'ba_landlord_claim_matched',
      targetType: 'landlord',
      targetId: landlord.id,
      metadata: { claimId: claim.id, referredAtSignup },
    });

    return res.status(201).json({
      matched: true,
      claim,
      landlord: {
        id: landlord.id,
        fullName: landlord.full_name,
        phone: landlord.phone,
        location: landlord.location,
        county: landlord.county,
        unitsCount: unitsCount || 0,
        subscriptionStatus: landlord.subscription_status,
      },
    });
  } catch (err) {
    logger.error('[brandAmbassador] submitLandlordClaim error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit landlord claim.' });
  }
}

// PHASE 4 - a BA's own claims, filterable by date range. Scoped
// server-side to req.user.id (the JWT), never a client-supplied BA id
// - see the Money & Data Integrity Rules ("a BA can only ever see
// their own data").
async function listMyClaims(req, res) {
  try {
    const baId = req.user.id;
    const { from, to } = req.query;

    let query = supabase
      .from('ba_landlord_claims')
      .select('*')
      .eq('ba_id', baId)
      .order('created_at', { ascending: false });

    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data: claims, error } = await query;
    if (error) throw error;

    return res.json({ claims: claims || [] });
  } catch (err) {
    logger.error('[brandAmbassador] listMyClaims error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load your claims.' });
  }
}

// ---------------------------------------------------------------------
// PHASE 7 - Sharing: WhatsApp Deep Link & In-App to Admin.
//
// Builds ONE plain-text summary of the BA's own claims for a selected
// date/range (name, phone, match+qualification status per landlord,
// plus a total count) and delivers it to admin two ways at once, not
// as a choice between them:
//   1. Returns the summary text to the frontend so it can open a
//      wa.me deep link (src/utils/whatsapp.js) pre-filled with it.
//   2. Posts the SAME text into the existing admin notifications
//      inbox via notify.service.js (recipientType 'admin',
//      recipientId 'super-admin' - the same mechanism every other
//      admin-facing in-app notification already uses, e.g.
//      2026-07-admin-notifications-support.sql). No parallel
//      messaging system is built for this.
//
// Scoped server-side to req.user.id, same as listMyClaims - a BA can
// only ever report on their own claims.
//
// PHASE 20 - the full report text below always lands as its own,
// untouched notifications row immediately (never batched, never
// summarized) - only the real-time PING that tells admin "something
// just arrived" is batched, via queueBatchedNotification, so several
// BAs reporting in the same short window produce one grouped push
// ("3 new BA reports - check your inbox") instead of a flood. See
// notificationBatch.service.js and notificationBatchFlush.job.js.
// ---------------------------------------------------------------------
const SHARE_REPORT_MAX_LISTED_CLAIMS = 50;

function formatClaimLine(c, index) {
  const status = `${c.match_status}${c.qualification_status ? `/${c.qualification_status}` : ''}`;
  return `${index + 1}. ${c.submitted_name} — ${c.submitted_phone} — ${status}`;
}

function buildClaimsReportSummary(ba, claims, { from, to } = {}) {
  const periodLabel = from || to ? `${from ? from.slice(0, 10) : '…'} to ${to ? to.slice(0, 10) : '…'}` : 'all time';
  const lines = claims.slice(0, SHARE_REPORT_MAX_LISTED_CLAIMS).map(formatClaimLine);
  const overflow = claims.length - lines.length;

  const header = `BA report from ${ba.full_name}${ba.ba_code ? ` (${ba.ba_code})` : ''} — ${periodLabel}`;
  const body = [header, '', ...lines];
  if (overflow > 0) body.push(`…and ${overflow} more (full list in admin inbox).`);
  body.push('', `Total: ${claims.length} landlord${claims.length === 1 ? '' : 's'}`);

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
      .from('ba_landlord_claims')
      .select('submitted_name, submitted_phone, match_status, qualification_status, created_at')
      .eq('ba_id', baId)
      .order('created_at', { ascending: false });
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data: claims, error: claimsErr } = await query;
    if (claimsErr) throw claimsErr;

    if (!claims || claims.length === 0) {
      return res.status(400).json({ error: 'No claims logged in this period to share.' });
    }

    const summary = buildClaimsReportSummary(ba, claims, { from, to });

    // Best-effort, same as every other notify() call site - a hiccup
    // here shouldn't stop the BA from still sending it themselves via
    // the WhatsApp link the response hands back. The full report body
    // always lands in the admin inbox immediately and unbatched
    // (urgent: false - the real-time push for this is handled
    // separately below, batched, so admin isn't pinged twice for one
    // report).
    try {
      await notify('admin', 'super-admin', null, summary, {
        title: `BA report: ${ba.full_name} (${claims.length} landlord${claims.length === 1 ? '' : 's'})`,
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
          metadata: { baId, count: claims.length },
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

    return res.json({ summary, count: claims.length });
  } catch (err) {
    logger.error('[brandAmbassador] shareClaimsReport error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to share your report.' });
  }
}

// PHASE 4 - editing an already-created claim's submitted fields
// (name/phone/location) after the fact. Every edit appends to
// edit_history rather than silently overwriting it - this is what
// powers the admin reconciliation tool in Phase 11. Scoped to the
// claim's owning BA via the JWT, same as listMyClaims.
async function editMyClaim(req, res) {
  try {
    const baId = req.user.id;
    const { id } = req.params;
    const { fullName, phone, location } = req.body;

    const { data: claim, error: findErr } = await supabase
      .from('ba_landlord_claims')
      .select('*')
      .eq('id', id)
      .eq('ba_id', baId)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!claim) return res.status(404).json({ error: 'Claim not found.' });

    const editedAt = new Date().toISOString();
    const editHistory = Array.isArray(claim.edit_history) ? [...claim.edit_history] : [];
    const updates = {};

    if (fullName !== undefined && fullName !== claim.submitted_name) {
      editHistory.push({ editedAt, editedField: 'submitted_name', oldValue: claim.submitted_name, newValue: fullName });
      updates.submitted_name = fullName;
    }
    if (phone !== undefined) {
      let normalizedPhone;
      try {
        normalizedPhone = normalizePhoneOrThrow(phone, 'Phone number');
      } catch (phoneErr) {
        return res.status(400).json({ error: phoneErr.message });
      }
      if (normalizedPhone !== claim.submitted_phone) {
        editHistory.push({ editedAt, editedField: 'submitted_phone', oldValue: claim.submitted_phone, newValue: normalizedPhone });
        updates.submitted_phone = normalizedPhone;
      }
    }
    if (location !== undefined && location !== claim.submitted_location) {
      editHistory.push({ editedAt, editedField: 'submitted_location', oldValue: claim.submitted_location, newValue: location });
      updates.submitted_location = location;
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ claim });
    }

    updates.edit_history = editHistory;

    const { data: updated, error: updateErr } = await supabase
      .from('ba_landlord_claims')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    return res.json({ claim: updated });
  } catch (err) {
    logger.error('[brandAmbassador] editMyClaim error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update claim.' });
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

    const [{ data: ba, error: baErr }, { data: claims, error: claimsErr }] = await Promise.all([
      supabase
        .from('brand_ambassadors')
        .select('id, current_commission_percent')
        .eq('id', baId)
        .maybeSingle(),
      supabase
        .from('ba_landlord_claims')
        .select('created_at, match_status, qualification_status')
        .eq('ba_id', baId)
        .gte('created_at', windowStart.toISOString())
        .order('created_at', { ascending: true }),
    ]);
    if (baErr) throw baErr;
    if (claimsErr) throw claimsErr;

    const rows = claims || [];
    const matchedRows = rows.filter((c) => c.match_status === 'matched');

    const now = new Date();
    const todayKey = dayKey(now);
    const thisWeekKey = weekKey(now);
    const thisMonthKey = monthKey(now);

    let onboardedToday = 0;
    let onboardedThisWeek = 0;
    let onboardedThisMonth = 0;
    let qualifiedCount = 0;

    const byDay = new Map(); // last 14 days, for the dashboard trend chart
    const byWeek = new Map(); // last 8 weeks, for the Stats section
    const byMonth = new Map(); // last 6 months, for the Stats section

    for (const c of matchedRows) {
      const created = new Date(c.created_at);
      const dKey = dayKey(created);
      const wKey = weekKey(created);
      const mKey = monthKey(created);

      if (dKey === todayKey) onboardedToday += 1;
      if (wKey === thisWeekKey) onboardedThisWeek += 1;
      if (mKey === thisMonthKey) onboardedThisMonth += 1;
      if (c.qualification_status === 'qualified' || c.qualification_status === 'paid') qualifiedCount += 1;

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

    const totalMatched = matchedRows.length;
    const qualificationRate = totalMatched > 0 ? Math.round((qualifiedCount / totalMatched) * 1000) / 10 : 0;

    // Next-tier progress. Prefer a ba_override ladder for this BA if
    // one exists, otherwise the global ladder (same precedence Phase
    // 10's qualification job uses for payout_rules/commission_tiers -
    // an override, when present, fully replaces the global ladder for
    // that BA rather than merging with it).
    const currentCommissionPercent = ba?.current_commission_percent || 0;
    let nextTier = null;
    try {
      const { data: overrideTiers } = await supabase
        .from('commission_tiers')
        .select('target_qualified_landlords, commission_percent')
        .eq('scope', 'ba_override')
        .eq('ba_id', baId)
        .order('target_qualified_landlords', { ascending: true });

      let ladder = overrideTiers || [];
      if (ladder.length === 0) {
        const { data: globalTiers } = await supabase
          .from('commission_tiers')
          .select('target_qualified_landlords, commission_percent')
          .eq('scope', 'global')
          .order('target_qualified_landlords', { ascending: true });
        ladder = globalTiers || [];
      }

      // Need the BA's all-time qualified count (not just this
      // STATS_WINDOW_DAYS window) to place them correctly on the
      // ladder - a small, separate count query, since tier progress
      // must reflect lifetime standing, not a rolling window.
      const { count: lifetimeQualified } = await supabase
        .from('ba_landlord_claims')
        .select('id', { count: 'exact', head: true })
        .eq('ba_id', baId)
        .in('qualification_status', ['qualified', 'paid']);

      const next = ladder.find((t) => t.target_qualified_landlords > (lifetimeQualified || 0));
      if (next) {
        nextTier = {
          targetQualifiedLandlords: next.target_qualified_landlords,
          commissionPercent: next.commission_percent,
          currentQualifiedLandlords: lifetimeQualified || 0,
        };
      }
    } catch (tierErr) {
      // Commission tiers may not be configured yet (Phase 10 not
      // built/seeded) - the dashboard should still render without
      // tier progress rather than fail the whole stats call.
      logger.warn('[brandAmbassador] getBaStats: tier lookup skipped:', tierErr.message);
    }

    return res.json({
      onboardedToday,
      onboardedThisWeek,
      onboardedThisMonth,
      qualifiedCount,
      qualificationRate,
      currentCommissionPercent,
      nextTier,
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

    let claimsQuery = supabase
      .from('ba_landlord_claims')
      .select('ba_id, qualification_status, qualified_at')
      .in('ba_id', activeIds.length ? activeIds : ['00000000-0000-0000-0000-000000000000'])
      .in('qualification_status', ['qualified', 'paid']);
    if (periodStart) claimsQuery = claimsQuery.gte('qualified_at', periodStart.toISOString());
    const { data: claims, error: claimsErr } = await claimsQuery;
    if (claimsErr) throw claimsErr;

    const countByBa = new Map();
    for (const c of claims || []) {
      countByBa.set(c.ba_id, (countByBa.get(c.ba_id) || 0) + 1);
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

module.exports = {
  requestBaEmailVerification,
  confirmBaEmailVerification,
  submitBaOnboarding,
  listPendingBaApplications,
  listBrandAmbassadors,
  approveBaApplication,
  rejectBaApplication,
  suspendBrandAmbassador,
  reactivateBrandAmbassador,
  offboardBrandAmbassador,
  getMyBaProfile,
  updateMyProfile,
  updateLeaderboardOptIn,
  resolveReferralCode,
  submitLandlordClaim,
  listMyClaims,
  shareClaimsReport,
  editMyClaim,
  getBaStats,
  getLeaderboard,
  REMINDER_THRESHOLD_HOURS,
};
