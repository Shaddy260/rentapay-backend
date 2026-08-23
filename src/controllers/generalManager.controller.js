// src/controllers/generalManager.controller.js
//
// RentaPay — General Manager Accounts (Sectioned Build Spec), Section 2.
//
// General Manager is a new, admin-provisioned-only account type -
// distinct from the existing "Property Manager" role (property_managers
// table), which a LANDLORD adds to help run their own properties. A
// General Manager is added by ADMIN and (per later sections of this
// spec) gets near-admin visibility across the whole platform.
//
// This controller only covers what Section 2 needs: creating the
// account and listing existing ones. Login (Section 3), the
// Operations PIN (Section 4), dashboard visibility scope (Section 5),
// edit-gating (Section 6), automatic logging (Section 7), per-manager
// log pages (Section 8), PDF export (Section 9), and admin revert
// (Section 10) are each their own later build step per the spec and
// are intentionally not implemented here.
//
// Every route here is already behind requireRole('admin') at the
// router level (see admin.routes.js) - there is deliberately no other
// route anywhere in the API that can write to the general_managers
// table, and no self-signup path exists for this role at all.

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { hashPassword, comparePassword, validatePasswordStrength } = require('../utils/password');
const { normalizePhoneOrThrow } = require('../utils/phone');
const { isValidEmail } = require('../utils/email');
const { findPhoneConflict } = require('../utils/phoneUniqueness');
const { findEmailConflict } = require('../utils/emailUniqueness');
const { generateOTP, getPasswordResetOTPExpiry, isOTPExpired } = require('../utils/otp');
const { checkAndRecordResend, clearResendAttempts } = require('../utils/resendRateLimit');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const templates = require('../services/notificationTemplates');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

function generateTempPassword() {
  // Same shape/strength as the property-manager and tenant temp
  // passwords elsewhere in this codebase (propertyManager.controller.js,
  // tenant.controller.js) - kept consistent rather than inventing a
  // new format for this one role.
  return `Rp${crypto.randomBytes(3).toString('hex')}!`;
}

// ---------------------------------------------------------------------
// CREATE GENERAL MANAGER (admin only)
// ---------------------------------------------------------------------
async function createGeneralManager(req, res) {
  try {
    const { fullName, gender } = req.body;
    let { phone, email } = req.body;

    const missing = Object.entries({ fullName, phone, email }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const trimmedEmail = String(email).trim();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    email = trimmedEmail;

    if (gender !== undefined && gender !== null && gender !== '' && !['male', 'female'].includes(gender)) {
      return res.status(400).json({ error: "gender must be 'male' or 'female'." });
    }

    try {
      phone = normalizePhoneOrThrow(phone, 'Phone number');
    } catch (phoneErr) {
      return res.status(400).json({ error: phoneErr.message });
    }

    // "No number should open more than one user account" - same
    // platform-wide rule every other role already follows.
    const phoneConflict = await findPhoneConflict(phone, 'general_manager');
    if (phoneConflict) return res.status(409).json({ error: phoneConflict });
    const emailConflict = await findEmailConflict(email, 'general_manager');
    if (emailConflict) return res.status(409).json({ error: emailConflict });

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    const { data: manager, error } = await supabase
      .from('general_managers')
      .insert({
        full_name: fullName,
        phone,
        email,
        password_hash: passwordHash,
        // Auto-verified, same reasoning as property managers: admin
        // already vouches for this account by creating it directly,
        // so first login just forces a real password (and, per
        // Section 4, an Operations PIN) instead of an OTP step.
        is_verified: true,
        must_change_password: true,
        gender: gender || null,
        created_by_admin: 'super-admin',
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A General Manager with this phone number or email already exists.' });
      throw error;
    }

    const emailBody = templates.generalManagerLoginCredentials(fullName, tempPassword);
    try {
      await sendEmail(email, "You've been added as a General Manager on RentaPay", wrapEmailHtml(emailBody));
    } catch (emailErr) {
      logger.error('[generalManager] createGeneralManager: CRITICAL - login credentials email failed to send:', emailErr.message);
      captureException(emailErr);
    }

    logActivity({
      actorType: 'admin',
      actorId: 'super-admin',
      action: 'general_manager_created',
      targetType: 'general_manager',
      targetId: manager.id,
      metadata: { fullName, phone, email },
      ipAddress: req.ip,
    });

    return res.status(201).json({
      message: 'General Manager added. Login details were sent via email.',
      manager: { ...manager, password_hash: undefined },
      // Shown once, right after creation, as a fallback in case the
      // email doesn't arrive - same pattern as addManager's
      // tempCredentials return for property managers.
      tempCredentials: { phone, email, tempPassword },
    });
  } catch (err) {
    logger.error('[generalManager] createGeneralManager error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to create General Manager account.' });
  }
}

// ---------------------------------------------------------------------
// LIST GENERAL MANAGERS (admin only)
// ---------------------------------------------------------------------
async function listGeneralManagers(req, res) {
  try {
    const { search } = req.query;

    let query = supabase
      .from('general_managers')
      .select('id, full_name, phone, email, gender, is_active, must_change_password, created_at, can_grant_loyalty_discounts, can_manage_manual_payments')
      .order('created_at', { ascending: false });

    if (search && search.trim()) {
      const safe = search.trim().replace(/[%_,]/g, (c) => `\\${c}`);
      query = query.or(`full_name.ilike.%${safe}%,phone.ilike.%${safe}%,email.ilike.%${safe}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ managers: data || [] });
  } catch (err) {
    logger.error('[generalManager] listGeneralManagers error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to fetch General Managers.' });
  }
}

// ---------------------------------------------------------------------
// SECTION 4 — Operations PIN Setup (Onboarding + Settings)
//
// Separate from the login password (Section 3) - a different secret
// with a different job (confirming actions, Section 6 - not logging
// in). A 4-digit PIN, hashed the same way a password is (bcrypt via
// hashPassword/comparePassword) and never returned by any endpoint
// once set. All three routes below require verifyToken +
// requireRole('general_manager') at the router level (see
// generalManager.routes.js) - a General Manager can only ever manage
// their OWN PIN, never anyone else's.
// ---------------------------------------------------------------------

const PIN_PATTERN = /^\d{4}$/;

function validatePin(pin) {
  if (!pin || !PIN_PATTERN.test(String(pin))) {
    return 'Operations PIN must be exactly 4 digits.';
  }
  return null;
}

// ---------------------------------------------------------------------
// SET OPERATIONS PIN (onboarding - first-time setup, no current PIN
// to confirm against yet). Refuses to run again once a PIN already
// exists - from that point on, changing it goes through
// changeOperationsPin below, which requires the current PIN.
// ---------------------------------------------------------------------
async function setOperationsPin(req, res) {
  try {
    const { pin, confirmPin } = req.body;
    if (pin !== confirmPin) {
      return res.status(400).json({ error: 'PIN and confirmation do not match.' });
    }
    const pinError = validatePin(pin);
    if (pinError) return res.status(400).json({ error: pinError });

    const { data: manager, error } = await supabase
      .from('general_managers')
      .select('id, operations_pin_hash, full_name')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error || !manager) return res.status(404).json({ error: 'Account not found.' });

    if (manager.operations_pin_hash) {
      return res.status(409).json({ error: 'An Operations PIN is already set. Use "Change PIN" in settings instead.' });
    }

    const pinHash = await hashPassword(pin);
    const { error: updateError } = await supabase
      .from('general_managers')
      .update({ operations_pin_hash: pinHash, operations_pin_set_at: new Date().toISOString() })
      .eq('id', req.user.id);
    if (updateError) throw updateError;

    logActivity({
      actorType: 'general_manager',
      actorId: req.user.id,
      action: 'operations_pin_set',
      targetType: 'general_manager',
      targetId: req.user.id,
      ipAddress: req.ip,
    });

    return res.json({ message: 'Operations PIN set.' });
  } catch (err) {
    logger.error('[generalManager] setOperationsPin error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to set Operations PIN.' });
  }
}

// ---------------------------------------------------------------------
// CHANGE OPERATIONS PIN (from settings, later - requires the current
// PIN, same pattern as changePassword() requiring currentPassword).
// ---------------------------------------------------------------------
async function changeOperationsPin(req, res) {
  try {
    const { currentPin, newPin, confirmNewPin } = req.body;
    if (!currentPin) {
      return res.status(400).json({ error: 'currentPin is required.' });
    }
    if (newPin !== confirmNewPin) {
      return res.status(400).json({ error: 'New PIN and confirmation do not match.' });
    }
    const pinError = validatePin(newPin);
    if (pinError) return res.status(400).json({ error: pinError });
    if (newPin === currentPin) {
      return res.status(400).json({ error: 'New PIN must be different from your current PIN.' });
    }

    const { data: manager, error } = await supabase
      .from('general_managers')
      .select('id, operations_pin_hash, full_name, email')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error || !manager) return res.status(404).json({ error: 'Account not found.' });

    if (!manager.operations_pin_hash) {
      return res.status(409).json({ error: 'No Operations PIN is set yet. Complete onboarding first.' });
    }

    const currentMatches = await comparePassword(currentPin, manager.operations_pin_hash);
    if (!currentMatches) {
      return res.status(401).json({ error: 'Current PIN is incorrect.' });
    }

    const newHash = await hashPassword(newPin);
    const { error: updateError } = await supabase
      .from('general_managers')
      .update({ operations_pin_hash: newHash, operations_pin_set_at: new Date().toISOString() })
      .eq('id', req.user.id);
    if (updateError) throw updateError;

    try {
      if (manager.email) {
        await sendEmail(manager.email, 'Your RentaPay Operations PIN was changed', wrapEmailHtml(templates.operationsPinChanged(manager.full_name)));
      }
    } catch (emailErr) {
      logger.warn('[generalManager] changeOperationsPin: confirmation email failed (non-fatal):', emailErr.message);
      captureException(emailErr);
    }

    logActivity({
      actorType: 'general_manager',
      actorId: req.user.id,
      action: 'operations_pin_changed',
      targetType: 'general_manager',
      targetId: req.user.id,
      ipAddress: req.ip,
    });

    return res.json({ message: 'Operations PIN changed.' });
  } catch (err) {
    logger.error('[generalManager] changeOperationsPin error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to change Operations PIN.' });
  }
}

// ---------------------------------------------------------------------
// FORGOT PIN, STEP 1: request a reset code by email. Requires an
// authenticated General Manager session (unlike the login-password
// forgot-password flow, which is necessarily unauthenticated) - a
// forgotten PIN doesn't lock someone out of the account entirely, only
// out of PIN-gated actions, so this stays behind verifyToken rather
// than being a public endpoint. Sent to the account's own registered
// email - "the General Manager must prove ownership of their
// registered email before a new PIN can be set."
// ---------------------------------------------------------------------
async function requestOperationsPinReset(req, res) {
  try {
    const { data: manager, error } = await supabase
      .from('general_managers')
      .select('id, email, full_name')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error || !manager) return res.status(404).json({ error: 'Account not found.' });

    const rateCheck = checkAndRecordResend('gm-pin-reset', manager.email);
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: `Too many attempts. Please try again in ${rateCheck.retryAfterMinutes} minute(s).` });
    }

    const otp = generateOTP();
    const otpExpiresAt = getPasswordResetOTPExpiry(); // same 5-minute window as every other live reset code in this codebase

    const { error: updateError } = await supabase
      .from('general_managers')
      .update({ pin_reset_otp: otp, pin_reset_otp_expires_at: otpExpiresAt.toISOString() })
      .eq('id', manager.id);
    if (updateError) throw updateError;

    try {
      await sendEmail(manager.email, 'Your RentaPay Operations PIN reset code', wrapEmailHtml(templates.operationsPinResetOtpMessage(otp)));
    } catch (emailErr) {
      logger.error('[generalManager] requestOperationsPinReset: email send failed:', emailErr.message);
      captureException(emailErr);
    }

    return res.json({ message: 'A reset code has been sent to your registered email.' });
  } catch (err) {
    logger.error('[generalManager] requestOperationsPinReset error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to send reset code.' });
  }
}

// ---------------------------------------------------------------------
// FORGOT PIN, STEP 2: submit the emailed code + a new PIN.
// ---------------------------------------------------------------------
async function resetOperationsPin(req, res) {
  try {
    const { otp, newPin, confirmNewPin } = req.body;
    if (!otp) {
      return res.status(400).json({ error: 'otp is required.' });
    }
    if (newPin !== confirmNewPin) {
      return res.status(400).json({ error: 'New PIN and confirmation do not match.' });
    }
    const pinError = validatePin(newPin);
    if (pinError) return res.status(400).json({ error: pinError });

    const { data: manager, error } = await supabase
      .from('general_managers')
      .select('id, email, full_name, pin_reset_otp, pin_reset_otp_expires_at')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error || !manager) return res.status(404).json({ error: 'Account not found.' });

    if (!manager.pin_reset_otp || manager.pin_reset_otp !== otp) {
      return res.status(400).json({ error: 'Invalid code.' });
    }
    if (isOTPExpired(manager.pin_reset_otp_expires_at)) {
      return res.status(400).json({ error: 'That code has expired. Request a new one.' });
    }

    const newHash = await hashPassword(newPin);
    const { error: updateError } = await supabase
      .from('general_managers')
      .update({
        operations_pin_hash: newHash,
        operations_pin_set_at: new Date().toISOString(),
        pin_reset_otp: null,
        pin_reset_otp_expires_at: null,
      })
      .eq('id', manager.id);
    if (updateError) throw updateError;

    try {
      if (manager.email) {
        await sendEmail(manager.email, 'Your RentaPay Operations PIN was reset', wrapEmailHtml(templates.operationsPinChanged(manager.full_name)));
      }
    } catch (emailErr) {
      logger.warn('[generalManager] resetOperationsPin: confirmation email failed (non-fatal):', emailErr.message);
      captureException(emailErr);
    }

    logActivity({
      actorType: 'general_manager',
      actorId: manager.id,
      action: 'operations_pin_reset',
      targetType: 'general_manager',
      targetId: manager.id,
      ipAddress: req.ip,
    });

    clearResendAttempts('gm-pin-reset', manager.email);
    return res.json({ message: 'Operations PIN reset. You can now use your new PIN.' });
  } catch (err) {
    logger.error('[generalManager] resetOperationsPin error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to reset Operations PIN.' });
  }
}

// ---------------------------------------------------------------------
// SUSPEND / ACTIVATE GENERAL MANAGER ACCOUNT (admin only)
//
// Distinct from suspending a landlord/tenant/BA account, which a
// General Manager can do to others (Section 6) - this is admin
// managing a General Manager's own account, same category as
// creating one (Section 2: "General Managers cannot create other
// General Manager accounts"), so by the same logic they can't
// suspend/reactivate one either. No PIN-confirm branch needed here -
// this endpoint is only ever reached through the admin-only
// /admin/general-managers routes; there is no general_manager-role
// path to it at all.
//
// A suspended General Manager's is_active flip is already enforced at
// login (see auth.controller.js's generalManagerLogin - it rejects
// with accountSuspended: true) - this is simply the missing admin
// affordance to flip that flag, matching the same suspend/activate
// pattern already used for landlords (admin.controller.js) and Brand
// Ambassadors (brandAmbassador.controller.js).
// ---------------------------------------------------------------------
async function setGeneralManagerStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'active' | 'suspended'
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active' or 'suspended'." });
    }

    const { data: manager, error: findErr } = await supabase
      .from('general_managers')
      .select('id, full_name, is_active')
      .eq('id', id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!manager) return res.status(404).json({ error: 'General Manager not found.' });

    const wantActive = status === 'active';
    if (manager.is_active === wantActive) {
      return res.status(400).json({ error: `This General Manager is already ${status}.` });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('general_managers')
      .update({ is_active: wantActive })
      .eq('id', id)
      .select('id, full_name, is_active')
      .single();
    if (updateErr) throw updateErr;

    logActivity({
      actorType: 'admin',
      actorId: 'super-admin',
      action: `general_manager_${status}`,
      targetType: 'general_manager',
      targetId: id,
      metadata: { fullName: manager.full_name },
      ipAddress: req.ip,
    });

    return res.json({
      message: `General Manager ${status === 'active' ? 'activated' : 'suspended'}.`,
      manager: updated,
    });
  } catch (err) {
    logger.error('[generalManager] setGeneralManagerStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update this General Manager\'s status.' });
  }
}

// ---------------------------------------------------------------------
// SECTION 2 UPDATE — self-service onboarding link, matching the BA
// onboarding pattern (brandAmbassador.controller.js): admin generates
// one live link and sends it privately to the specific person they
// want to invite; that person fills in their own details and verifies
// their own email, rather than admin typing everything in.
//
// FIX: this used to skip the approval queue entirely on the theory
// that "admin already chose this exact person by generating the
// link" - but the link is a single shared URL, not single-use or
// tied to any one recipient, so anyone who got hold of it could
// submit their own details and land an active, credentialed General
// Manager account with no admin review at all. Submission now behaves
// exactly like BA onboarding: it creates a 'pending_approval' row
// (is_active stays false, no credentials are sent) and admin must
// explicitly approve or reject it - see approveGmApplication /
// rejectGmApplication below - before the account can log in.
// ---------------------------------------------------------------------

const { generateOTP: generateGmOTP, getEmailVerificationOTPExpiry, isOTPExpired: isGmOTPExpired } = require('../utils/otp');
const { sendEmail: sendGmEmail, wrapEmailHtml: wrapGmEmailHtml, SUPPORT_EMAIL: GM_SUPPORT_EMAIL } = require('../services/email.service');

const GM_ONBOARDING_LINK_TTL_HOURS = 24;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rentapay.co.ke';

function generateGmOnboardingLinkToken() {
  return crypto.randomBytes(20).toString('hex');
}

async function getCurrentGmOnboardingLink() {
  const { data, error } = await supabase
    .from('gm_onboarding_links')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function isGmLinkExpired(link) {
  return !link || new Date(link.expires_at) <= new Date();
}

async function checkGmOnboardingLinkToken(token) {
  if (!token) {
    return { ok: false, error: 'This onboarding link is invalid. Please request a new one from RentaPay.' };
  }
  const current = await getCurrentGmOnboardingLink();
  if (isGmLinkExpired(current) || current.token !== String(token)) {
    return { ok: false, error: 'This onboarding link has expired. Please request a new one from RentaPay.' };
  }
  return { ok: true };
}

// ADMIN — current link status, so the "Onboard a new General Manager"
// card can show the live link without regenerating it just to look.
async function getGmOnboardingLinkStatus(req, res) {
  try {
    const current = await getCurrentGmOnboardingLink();
    const expired = isGmLinkExpired(current);
    return res.json({
      link: current && !expired ? `${FRONTEND_URL}/onboard-general-manager?token=${current.token}` : null,
      expiresAt: current?.expires_at || null,
      expired,
    });
  } catch (err) {
    logger.error('[generalManager] getGmOnboardingLinkStatus error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the onboarding link.' });
  }
}

// ADMIN — generate/regenerate. Fresh row + fresh token every time, so
// regenerating early immediately invalidates whatever link was live.
async function generateGmOnboardingLink(req, res) {
  try {
    const token = generateGmOnboardingLinkToken();
    const expiresAt = new Date(Date.now() + GM_ONBOARDING_LINK_TTL_HOURS * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('gm_onboarding_links')
      .insert({ token, generated_by: req.user?.id || 'super-admin', expires_at: expiresAt.toISOString() })
      .select()
      .single();
    if (error) throw error;

    logActivity({ actorType: 'admin', actorId: req.user?.id || 'super-admin', action: 'gm_onboarding_link_generated', targetType: 'gm_onboarding_link', targetId: data.id });

    return res.status(201).json({
      link: `${FRONTEND_URL}/onboard-general-manager?token=${token}`,
      expiresAt: data.expires_at,
    });
  } catch (err) {
    logger.error('[generalManager] generateGmOnboardingLink error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to generate a new onboarding link.' });
  }
}

// PUBLIC — lets the onboarding page check its ?token= on load.
async function validateGmOnboardingLinkToken(req, res) {
  try {
    const { token } = req.query;
    const result = await checkGmOnboardingLinkToken(token);
    if (!result.ok) return res.status(410).json({ valid: false, error: result.error });
    return res.json({ valid: true });
  } catch (err) {
    logger.error('[generalManager] validateGmOnboardingLinkToken error:', err.message);
    captureException(err);
    return res.status(500).json({ valid: false, error: 'Failed to validate link.' });
  }
}

// PUBLIC — step 1: send a code to the email the invitee typed.
async function requestGmEmailVerification(req, res) {
  try {
    const { email, onboardingToken } = req.body;
    const linkCheck = await checkGmOnboardingLinkToken(onboardingToken);
    if (!linkCheck.ok) return res.status(410).json({ error: linkCheck.error, linkExpired: true });

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    const otp = generateGmOTP();
    const expiresAt = getEmailVerificationOTPExpiry();

    const { error: upsertErr } = await supabase
      .from('gm_email_otps')
      .upsert(
        { email: normalizedEmail, otp_code: otp, expires_at: expiresAt.toISOString(), verified: false, verification_token: null, failed_attempts: 0, locked_until: null },
        { onConflict: 'email' }
      );
    if (upsertErr) throw upsertErr;

    try {
      await sendGmEmail(
        normalizedEmail,
        'Verify your email - RentaPay General Manager onboarding',
        wrapGmEmailHtml(`Your verification code is: ${otp}\n\nThis code expires in 10 minutes. Enter it on the General Manager onboarding form to verify your email.`)
      );
    } catch (emailErr) {
      logger.error('[generalManager] requestGmEmailVerification: failed to send:', emailErr.message);
      captureException(emailErr);
      return res.status(502).json({ error: 'Could not send the verification email. Please check the address and try again.' });
    }

    return res.json({ message: 'Verification code sent to your email.' });
  } catch (err) {
    logger.error('[generalManager] requestGmEmailVerification error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to send verification code.' });
  }
}

// PUBLIC — step 2: confirm the code, hand back an opaque proof token.
async function confirmGmEmailVerification(req, res) {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const { data: record, error: recordErr } = await supabase
      .from('gm_email_otps')
      .select('*')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (recordErr) throw recordErr;
    if (!record) return res.status(400).json({ error: 'Request a verification code for this email first.' });

    if (record.locked_until && new Date(record.locked_until) > new Date()) {
      return res.status(423).json({ error: `Too many incorrect codes. Try again after ${record.locked_until}, or request a new code.` });
    }
    if (isGmOTPExpired(record.expires_at)) {
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
      await supabase.from('gm_email_otps').update(update).eq('id', record.id);
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }

    const verificationToken = crypto.randomBytes(24).toString('hex');
    await supabase
      .from('gm_email_otps')
      .update({ verified: true, verification_token: verificationToken, failed_attempts: 0, locked_until: null })
      .eq('id', record.id);

    return res.json({ verified: true, emailVerification: verificationToken });
  } catch (err) {
    logger.error('[generalManager] confirmGmEmailVerification error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to verify code.' });
  }
}

// PUBLIC — step 3: the invitee's own submission. Creates a
// pending_approval row - is_active stays false and no credentials go
// out until admin approves (see note above).
async function submitGmOnboarding(req, res) {
  try {
    const { fullName, gender, emailVerification, onboardingToken } = req.body;
    let { phone, email, nationalId } = req.body;

    const linkCheck = await checkGmOnboardingLinkToken(onboardingToken);
    if (!linkCheck.ok) return res.status(410).json({ error: linkCheck.error, linkExpired: true });

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

    if (gender !== undefined && gender !== null && gender !== '' && !['male', 'female'].includes(gender)) {
      return res.status(400).json({ error: "gender must be 'male' or 'female'." });
    }

    if (!emailVerification) {
      return res.status(400).json({ error: 'Please verify your email address before submitting.', emailNotVerified: true });
    }
    const { data: otpRecord, error: otpErr } = await supabase
      .from('gm_email_otps')
      .select('verified, verification_token')
      .eq('email', email)
      .maybeSingle();
    if (otpErr) throw otpErr;
    if (!otpRecord?.verified || otpRecord.verification_token !== emailVerification) {
      return res.status(400).json({ error: 'Please verify your email address before submitting.', emailNotVerified: true });
    }

    const phoneConflict = await findPhoneConflict(phone, 'general_manager');
    if (phoneConflict) return res.status(409).json({ error: phoneConflict });
    const emailConflict = await findEmailConflict(email, 'general_manager');
    if (emailConflict) return res.status(409).json({ error: emailConflict });

    // No password/credentials are generated at submission time anymore
    // - those only get created on approval (approveGmApplication),
    // same as BA onboarding. is_active defaults to false at the
    // column level, but is set explicitly here for clarity.
    let application;
    try {
      const { data, error } = await supabase
        .from('general_managers')
        .insert({
          full_name: fullName,
          phone,
          email,
          national_id: nationalId,
          password_hash: null,
          is_verified: true,
          is_active: false,
          status: 'pending_approval',
          gender: gender || null,
          created_by_admin: linkCheck.generatedBy || 'super-admin',
        })
        .select()
        .single();
      if (error) throw error;
      application = data;
    } catch (insertErr) {
      if (insertErr.code === '23505') {
        return res.status(409).json({ error: 'This phone number or email was just registered by another submission. Please check your details.' });
      }
      throw insertErr;
    }

    // Notify admin - best-effort, never blocks the response, same
    // convention as submitBaOnboarding's admin notify.
    if (GM_SUPPORT_EMAIL) {
      sendGmEmail(
        GM_SUPPORT_EMAIL,
        'New General Manager application awaiting review',
        wrapGmEmailHtml(
          `${fullName} submitted a General Manager onboarding form.\n\nPhone: ${phone}\nEmail: ${email}\nNational ID: ${nationalId}\n\nReview it in the admin portal under General Managers > Pending Applications.`
        )
      ).catch((notifyErr) => {
        logger.error('[generalManager] admin notify failed:', notifyErr.message);
        captureException(notifyErr);
      });
    }

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'general_manager_application_submitted', targetType: 'general_manager', targetId: application.id });

    return res.status(201).json({
      message: 'Your details have been submitted and are pending admin review. You will receive your login details by email once approved.',
      application: { id: application.id, status: application.status },
    });
  } catch (err) {
    logger.error('[generalManager] submitGmOnboarding error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to submit. Please try again.' });
  }
}

// ADMIN — GET /general-managers/applications?page= : the pending
// review queue, same shape as listPendingBaApplications.
async function listPendingGmApplications(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = 20;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await supabase
      .from('general_managers')
      .select('id, full_name, email, phone, national_id, gender, status, created_at', { count: 'exact' })
      .eq('status', 'pending_approval')
      .order('created_at', { ascending: true })
      .range(from, to);
    if (error) throw error;

    return res.json({ applications: data || [], total: count || 0, page, pageSize });
  } catch (err) {
    logger.error('[generalManager] listPendingGmApplications error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load pending applications.' });
  }
}

// ADMIN — POST /general-managers/:id/approve : flips a pending
// application to active, generates the temp password, and emails
// login credentials, mirroring approveBaApplication.
async function approveGmApplication(req, res) {
  try {
    const { id } = req.params;
    const { data: application, error: findErr } = await supabase
      .from('general_managers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!application) return res.status(404).json({ error: 'Application not found.' });
    if (application.status !== 'pending_approval') {
      return res.status(400).json({ error: `This application is already ${application.status}, not pending approval.` });
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    const { data: approved, error: updateErr } = await supabase
      .from('general_managers')
      .update({
        password_hash: passwordHash,
        must_change_password: true,
        is_active: true,
        status: 'active',
        reviewed_by_admin_id: req.user?.id || 'super-admin',
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    const emailBody = templates.generalManagerLoginCredentials(application.full_name, tempPassword);
    try {
      await sendGmEmail(application.email, "You've been added as a General Manager on RentaPay", wrapGmEmailHtml(emailBody));
    } catch (emailErr) {
      logger.error('[generalManager] approveGmApplication: CRITICAL - login credentials email failed to send:', emailErr.message);
      captureException(emailErr);
    }

    logActivity({
      actorType: 'admin',
      actorId: req.user?.id || 'super-admin',
      action: 'general_manager_application_approved',
      targetType: 'general_manager',
      targetId: approved.id,
    });

    return res.json({
      message: 'Application approved. Login credentials were sent to the applicant.',
      manager: { ...approved, password_hash: undefined },
      // Fallback in case delivery fails - same convention as
      // approveBaApplication's tempCredentials return.
      tempCredentials: { phone: application.phone, email: application.email, tempPassword },
    });
  } catch (err) {
    logger.error('[generalManager] approveGmApplication error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to approve application.' });
  }
}

// ADMIN — POST /general-managers/:id/reject, body: { reason? }
async function rejectGmApplication(req, res) {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data: application, error: findErr } = await supabase
      .from('general_managers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!application) return res.status(404).json({ error: 'Application not found.' });
    if (application.status !== 'pending_approval') {
      return res.status(400).json({ error: `This application is already ${application.status}, not pending approval.` });
    }

    const { data: rejected, error: updateErr } = await supabase
      .from('general_managers')
      .update({
        status: 'rejected',
        rejected_reason: reason || null,
        reviewed_by_admin_id: req.user?.id || 'super-admin',
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    // Does NOT delete the row (kept for audit history) and does NOT
    // block a future re-application - the partial unique indexes
    // exclude status = 'rejected'.
    sendGmEmail(
      application.email,
      'Your RentaPay General Manager application',
      wrapGmEmailHtml(
        `Thanks for your submission. Unfortunately your General Manager application wasn't approved at this time.${reason ? `\n\nReason: ${reason}` : ''}`
      )
    ).catch((emailErr) => {
      logger.error('[generalManager] rejectGmApplication: notify email failed:', emailErr.message);
      captureException(emailErr);
    });

    logActivity({
      actorType: 'admin',
      actorId: req.user?.id || 'super-admin',
      action: 'general_manager_application_rejected',
      targetType: 'general_manager',
      targetId: rejected.id,
      reason: reason || undefined,
    });

    return res.json({ message: 'Application rejected.', manager: { ...rejected, password_hash: undefined } });
  } catch (err) {
    logger.error('[generalManager] rejectGmApplication error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to reject application.' });
  }
}

// ADMIN — PATCH /general-managers/:id/permissions, body:
// { canGrantLoyaltyDiscounts?, canManageManualPayments? }
// FEATURE (direct request): per-manager toggles for two features that
// aren't part of the default General Manager scope - see
// requireGmPermission in auth.middleware.js for where these are
// actually enforced.
async function updateGmPermissions(req, res) {
  try {
    const { id } = req.params;
    const { canGrantLoyaltyDiscounts, canManageManualPayments } = req.body;

    const update = {};
    if (canGrantLoyaltyDiscounts !== undefined) update.can_grant_loyalty_discounts = !!canGrantLoyaltyDiscounts;
    if (canManageManualPayments !== undefined) update.can_manage_manual_payments = !!canManageManualPayments;
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { data: manager, error: findErr } = await supabase.from('general_managers').select('id').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!manager) return res.status(404).json({ error: 'General Manager not found.' });

    const { data: updated, error } = await supabase
      .from('general_managers')
      .update(update)
      .eq('id', id)
      .select('id, full_name, can_grant_loyalty_discounts, can_manage_manual_payments')
      .single();
    if (error) throw error;

    logActivity({
      actorType: 'admin',
      actorId: req.user?.id || 'super-admin',
      action: 'general_manager_permissions_updated',
      targetType: 'general_manager',
      targetId: id,
      metadata: update,
    });

    return res.json({ manager: updated });
  } catch (err) {
    logger.error('[generalManager] updateGmPermissions error:', err.message);
    captureException(err);
    return res.status(500).json({ error: "Failed to update this General Manager's permissions." });
  }
}

// SELF (general_manager) — GET /manager-account/me/permissions : lets
// the dashboard pick up an admin toggle change (loyalty
// grant/manual payments) without forcing a fresh login first.
async function getMyGmPermissions(req, res) {
  try {
    const { data: manager, error } = await supabase
      .from('general_managers')
      .select('can_grant_loyalty_discounts, can_manage_manual_payments')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!manager) return res.status(404).json({ error: 'Account not found.' });
    return res.json({
      canGrantLoyaltyDiscounts: !!manager.can_grant_loyalty_discounts,
      canManageManualPayments: !!manager.can_manage_manual_payments,
    });
  } catch (err) {
    logger.error('[generalManager] getMyGmPermissions error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load your permissions.' });
  }
}

module.exports = {
  createGeneralManager,
  listGeneralManagers,
  setGeneralManagerStatus,
  updateGmPermissions,
  getMyGmPermissions,
  setOperationsPin,
  changeOperationsPin,
  requestOperationsPinReset,
  resetOperationsPin,
  getGmOnboardingLinkStatus,
  generateGmOnboardingLink,
  validateGmOnboardingLinkToken,
  listPendingGmApplications,
  approveGmApplication,
  rejectGmApplication,
  requestGmEmailVerification,
  confirmGmEmailVerification,
  submitGmOnboarding,
};
