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
      .select('id, full_name, phone, email, gender, is_active, must_change_password, created_at')
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

module.exports = {
  createGeneralManager,
  listGeneralManagers,
  setGeneralManagerStatus,
  setOperationsPin,
  changeOperationsPin,
  requestOperationsPinReset,
  resetOperationsPin,
};
