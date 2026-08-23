// src/services/baPayoutSubmissionLink.service.js
//
// BUILD SPEC PHASE 10 (v2) - Universal BA Payout Links + Email/OTP Gate.
//
// Owns:
//   - the (non-expiring, truly universal - one static URL for every
//     BA) submission channel gate: request-OTP / verify-OTP against a
//     BA's registered email, producing a short-lived verification
//     token that authorizes exactly one submitPaymentDetails() call.
//   - the universal, admin-issued, 24h-rotating edit link (same
//     "latest row wins" convention as ba_onboarding_links), plus its
//     own request-OTP / verify-OTP gate producing a verification token
//     that authorizes exactly one applyEdit() call.
//
// No account-existence oracle: requestSubmissionOtp/requestEditOtp
// ALWAYS resolve to the same generic outcome regardless of whether the
// email matches an eligible BA - only an eligible match actually
// triggers an email send.

const crypto = require('crypto');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { generateOTP, getEmailVerificationOTPExpiry, isOTPExpired } = require('../utils/otp');
const { sendEmail, wrapEmailHtml } = require('./email.service');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rentapay.co.ke';
const EDIT_LINK_TTL_HOURS = 24;
const VERIFICATION_TOKEN_TTL_MINUTES = 15;
const OTP_LOCKOUT_ATTEMPTS = 5;
const OTP_LOCKOUT_MINUTES = 15;

function generateToken(bytes = 20) {
  return crypto.randomBytes(bytes).toString('hex');
}

// The submission link is a single, permanent, static URL - never
// carries a token, never expires, never regenerated. Every BA is sent
// (or can be given) the exact same link.
function submissionLink() {
  return `${FRONTEND_URL}/ba-payout-submit`;
}

function editLinkForToken(token) {
  return `${FRONTEND_URL}/ba-payout-edit?token=${token}`;
}

// =====================================================================
// Universal 24h edit link (admin-managed) - same convention as
// ba_onboarding_links: "the current link" is always just the most
// recently generated row; regenerating early kills the previous one
// immediately since only the latest row is ever honoured.
// =====================================================================

async function getCurrentEditLink() {
  const { data, error } = await supabase
    .from('ba_payout_edit_links')
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

// ADMIN - current edit-link status, for the admin portal to show the
// live link + expiry without generating a new one just to look at it.
async function getEditLinkStatus() {
  const current = await getCurrentEditLink();
  const expired = isLinkExpired(current);
  return {
    link: current && !expired ? editLinkForToken(current.token) : null,
    expiresAt: current?.expires_at || null,
    expired,
  };
}

// ADMIN - generate (or regenerate) the universal edit link. Always
// inserts a fresh row/token - regenerating immediately invalidates
// whatever link was live before. Expires 24h from generation.
async function generateEditLink({ adminId } = {}) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + EDIT_LINK_TTL_HOURS * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('ba_payout_edit_links')
    .insert({ token, generated_by: adminId || null, expires_at: expiresAt.toISOString() })
    .select()
    .single();
  if (error) throw error;

  return { link: editLinkForToken(token), expiresAt: data.expires_at };
}

// Shared gate: does this ?token= match the currently-live edit link,
// and is it still within its 24h window? Turns away stale/copy-pasted
// links with the same "request a new one" message either way.
async function checkEditLinkToken(token) {
  if (!token) {
    return { ok: false, error: 'This correction link is invalid. Please ask RentaPay admin for a new one.' };
  }
  const current = await getCurrentEditLink();
  if (isLinkExpired(current) || current.token !== String(token)) {
    return { ok: false, error: 'This correction link has expired (correction links are valid for 24 hours). Please ask RentaPay admin for a new one.' };
  }
  return { ok: true };
}

async function validateEditLinkToken(token) {
  return checkEditLinkToken(token);
}

// =====================================================================
// Email + OTP gate, shared shape for both purposes ('submit' | 'edit').
// =====================================================================

function lockoutActive(record) {
  return record.locked_until && new Date(record.locked_until) > new Date();
}

// Look up an eligible BA for the given purpose:
//   'submit' -> active/suspended account that has NOT yet submitted.
//   'edit'   -> active/suspended account that HAS already submitted
//               (nothing to correct otherwise).
async function findEligibleBa(email, purpose) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from('brand_ambassadors')
    .select('id, full_name, email, status, payout_submission_used_at')
    .ilike('email', normalized)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.status !== 'active' && data.status !== 'suspended') return null;

  if (purpose === 'submit' && data.payout_submission_used_at) return null;
  if (purpose === 'edit' && !data.payout_submission_used_at) return null;
  return data;
}

// Notice sent to a BA who tries the 'submit' flow again after already
// submitting: no OTP, just a heads-up that the one-time submission
// channel is closed and how to actually get a correction made. Includes
// the current live 24h edit link when one exists so they can go
// straight to it; if none is live right now, points them to ask admin
// for one instead of linking somewhere that would just 404/expire.
async function notifyAlreadySubmitted(ba) {
  const editStatus = await getEditLinkStatus();
  const subject = 'You\u2019ve already submitted your RentaPay payout details';
  const body = editStatus.link
    ? `Hi ${ba.full_name || 'there'},\n\nWe noticed you tried to submit your payout details again, but our records show you've already submitted these once - each Brand Ambassador can only use the submission link one time.\n\nIf something needs correcting, use this correction link instead (valid for 24 hours from when it was generated):\n${editStatus.link}\n\nIf this link has expired by the time you click it, just reply to this email or contact RentaPay admin for a new one.`
    : `Hi ${ba.full_name || 'there'},\n\nWe noticed you tried to submit your payout details again, but our records show you've already submitted these once - each Brand Ambassador can only use the submission link one time.\n\nIf something needs correcting, please contact RentaPay admin and ask for a correction link - there isn't one currently active.`;

  try {
    await sendEmail(ba.email, subject, wrapEmailHtml(body));
  } catch (emailErr) {
    logger.error('[baPayoutSubmissionLink] notifyAlreadySubmitted send failed:', emailErr.message);
    // Best-effort, same convention as every other notification send in
    // this file - never blocks or rolls back the caller's request.
  }
}

// PUBLIC - step 1 for either flow: send a code to the typed email, IF
// (and only if) it belongs to an eligible BA. Always resolves the same
// way regardless of match, so the response itself never reveals
// whether the account exists.
async function requestOtp({ email, purpose, editLinkToken }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const genericResult = { requested: true };

  if (purpose === 'edit') {
    const linkCheck = await checkEditLinkToken(editLinkToken);
    if (!linkCheck.ok) {
      const err = new Error(linkCheck.error);
      err.linkInvalid = true;
      throw err;
    }
  }

  const ba = await findEligibleBa(normalizedEmail, purpose);
  if (!ba) {
    // FIX (direct request: "when the ones who had already submitted...
    // it does not send email... it fails to notice the users, it
    // should notice them and ask for the correction link instead"):
    // a BA who already submitted hits exactly this branch on the
    // 'submit' flow (findEligibleBa excludes them on purpose - see
    // above), and used to just dead-end silently with no email at
    // all, leaving them thinking the form is broken. Only the
    // 'submit' flow gets this extra check - 'edit' has no equivalent
    // "already-edited" state to notice them about. The API response
    // itself stays exactly the same generic { requested: true } either
    // way, so this still never reveals account existence to whoever's
    // calling the endpoint - only a real, already-submitted BA's own
    // inbox gets anything.
    if (purpose === 'submit') {
      const alreadySubmittedBa = await findEligibleBa(normalizedEmail, 'edit');
      if (alreadySubmittedBa) {
        await notifyAlreadySubmitted(alreadySubmittedBa);
      }
    }
    return genericResult;
  }

  const otp = generateOTP();
  const expiresAt = getEmailVerificationOTPExpiry();

  const { error } = await supabase
    .from('ba_payout_link_otps')
    .upsert(
      {
        email: normalizedEmail,
        purpose,
        edit_link_token: purpose === 'edit' ? String(editLinkToken) : null,
        otp_code: otp,
        expires_at: expiresAt.toISOString(),
        verified: false,
        verification_token: null,
        verification_expires_at: null,
        consumed_at: null,
        failed_attempts: 0,
        locked_until: null,
      },
      { onConflict: 'email,purpose' }
    );
  if (error) throw error;

  const subject =
    purpose === 'edit'
      ? 'Your RentaPay Brand Ambassador correction code'
      : 'Your RentaPay Brand Ambassador payout verification code';
  const body =
    purpose === 'edit'
      ? `Your correction code is: ${otp}\n\nThis code expires in 10 minutes. Enter it to update your on-file payout details.`
      : `Your verification code is: ${otp}\n\nThis code expires in 10 minutes. Enter it to submit your payout details.`;

  try {
    await sendEmail(ba.email, subject, wrapEmailHtml(body));
  } catch (emailErr) {
    logger.error(`[baPayoutSubmissionLink] requestOtp(${purpose}) send failed:`, emailErr.message);
    // Still don't reveal anything different to the caller - this is a
    // best-effort send, matching the rest of the app's convention of
    // never rolling back on a failed notification.
  }

  return genericResult;
}

// PUBLIC - step 2 for either flow: confirm the code, return a
// short-lived verification token scoped to this exact BA + purpose
// (+ edit link token, for 'edit').
async function verifyOtp({ email, purpose, code }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !code) {
    const err = new Error('Email and code are required.');
    err.validation = true;
    throw err;
  }

  const { data: record, error } = await supabase
    .from('ba_payout_link_otps')
    .select('*')
    .eq('email', normalizedEmail)
    .eq('purpose', purpose)
    .maybeSingle();
  if (error) throw error;

  // Deliberately the same generic message as "wrong code" below -
  // never confirms/denies whether this email was ever eligible.
  const genericInvalid = () => {
    const err = new Error('Incorrect or expired code. Please check the code or request a new one.');
    err.validation = true;
    return err;
  };

  if (!record) throw genericInvalid();
  if (lockoutActive(record)) {
    const err = new Error(`Too many incorrect codes. Please try again after ${record.locked_until}, or request a new code.`);
    err.validation = true;
    throw err;
  }
  if (isOTPExpired(record.expires_at)) throw genericInvalid();
  if (record.otp_code !== String(code).trim()) {
    const failedAttempts = (record.failed_attempts || 0) + 1;
    const update = { failed_attempts: failedAttempts };
    if (failedAttempts >= OTP_LOCKOUT_ATTEMPTS) {
      const lockUntil = new Date();
      lockUntil.setMinutes(lockUntil.getMinutes() + OTP_LOCKOUT_MINUTES);
      update.locked_until = lockUntil.toISOString();
    }
    await supabase.from('ba_payout_link_otps').update(update).eq('id', record.id);
    throw genericInvalid();
  }

  // For 'edit', the OTP session must still be pinned to the currently
  // live edit link - if admin regenerated the link mid-flow, this
  // session dies with the old link rather than silently carrying over.
  if (purpose === 'edit') {
    const linkCheck = await checkEditLinkToken(record.edit_link_token);
    if (!linkCheck.ok) {
      const err = new Error(linkCheck.error);
      err.linkInvalid = true;
      throw err;
    }
  }

  const verificationToken = generateToken(24);
  const verificationExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MINUTES * 60 * 1000);

  const { error: updateErr } = await supabase
    .from('ba_payout_link_otps')
    .update({
      verified: true,
      verification_token: verificationToken,
      verification_expires_at: verificationExpiresAt.toISOString(),
      failed_attempts: 0,
      locked_until: null,
    })
    .eq('id', record.id);
  if (updateErr) throw updateErr;

  return { verificationToken, expiresAt: verificationExpiresAt.toISOString() };
}

// Resolve a verification token into the BA it was issued for. Used by
// baPaymentSubmission.service's submitPaymentDetails/applyEdit as the
// ONLY way in - single-use (consumed_at) and short-lived.
async function resolveVerificationToken({ verificationToken, purpose }) {
  if (!verificationToken) {
    const err = new Error('Please verify your email with the code first.');
    err.validation = true;
    throw err;
  }

  const { data: record, error } = await supabase
    .from('ba_payout_link_otps')
    .select('*')
    .eq('verification_token', String(verificationToken))
    .eq('purpose', purpose)
    .maybeSingle();
  if (error) throw error;

  const invalid = (msg) => {
    const err = new Error(msg);
    err.linkInvalid = true;
    return err;
  };

  if (!record || !record.verified) throw invalid('Your verification has expired. Please verify your email again.');
  if (record.consumed_at) throw invalid('This verification has already been used. Please verify your email again.');
  if (new Date(record.verification_expires_at).getTime() < Date.now()) {
    throw invalid('Your verification has expired. Please verify your email again.');
  }
  if (purpose === 'edit') {
    const linkCheck = await checkEditLinkToken(record.edit_link_token);
    if (!linkCheck.ok) throw invalid(linkCheck.error);
  }

  const ba = await findEligibleBa(record.email, purpose);
  if (!ba) {
    throw invalid(
      purpose === 'submit'
        ? 'This payout link has already been used. Each Brand Ambassador can only submit once.'
        : 'No on-file submission was found to correct for this Brand Ambassador.'
    );
  }

  return { ba, otpRecordId: record.id };
}

async function markVerificationConsumed(otpRecordId) {
  const { error } = await supabase
    .from('ba_payout_link_otps')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', otpRecordId)
    .is('consumed_at', null);
  if (error) throw error;
}

module.exports = {
  submissionLink,
  editLinkForToken,
  getEditLinkStatus,
  generateEditLink,
  validateEditLinkToken,
  requestOtp,
  verifyOtp,
  resolveVerificationToken,
  markVerificationConsumed,
  EDIT_LINK_TTL_HOURS,
};
