// src/services/baPaymentSubmission.service.js
//
// BUILD SPEC PHASE 10 - Fix: BA Payout Submission Overwrite Bug.
//
// Owns the write/read path for `ba_payment_submissions` - now exactly
// ONE row per BA, ever, capturing their M-Pesa/name/email on file.
//
//   - submitPaymentDetails()  - the one-time submission. Plain INSERT,
//     never an upsert - there is no overwrite path here at all. Gated
//     server-side by baPayoutSubmissionLink.validateSubmissionAttempt
//     (token must be unused) AND by the unique index on ba_id (belt
//     and braces - even a race can't produce two rows for one BA).
//   - applyEdit()             - the ONLY way to change an on-file
//     submission after the fact, gated by a distinct, admin-issued,
//     24h edit link (never by resubmitting through the original
//     channel).
//   - getMySubmission()       - lets the BA look their own on-file
//     details back up.
//
// Payout PAID/PENDING status does not live here at all - see
// baPendingPayouts.service.js / baCompletedPayouts.service.js, which
// now read/write ba_payouts instead. A completed payout can never be
// affected by anything in this file.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { normalizePhoneOrThrow } = require('../utils/phone');
const {
  validateSubmissionAttempt,
  markSubmissionUsed,
  validateEditLink,
  markEditLinkUsed,
} = require('./baPayoutSubmissionLink.service');

function assertDetailsValid({ mpesaNumber, submittedName }) {
  const normalizedMpesa = normalizePhoneOrThrow(mpesaNumber, 'M-Pesa number');
  const normalizedName = String(submittedName || '').trim();
  if (!normalizedName) {
    const err = new Error('Please enter the name registered on this M-Pesa number.');
    err.validation = true;
    throw err;
  }
  return { normalizedMpesa, normalizedName };
}

// ---------------------------------------------------------------------
// Look up an active Brand Ambassador by their account email. Matching
// is by email, case-insensitive, exact (no fuzzy matching).
// ---------------------------------------------------------------------
async function findPayableBaByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from('brand_ambassadors')
    .select('id, full_name, email, status, payout_submission_token')
    .ilike('email', normalized)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return data;
}

// ---------------------------------------------------------------------
// The ONE-TIME submission. No resubmission path exists here: once
// this succeeds, the BA's payout_submission_used_at is stamped and
// the channel is permanently closed - any further attempt (old link,
// bookmark, replay) is rejected outright by validateSubmissionAttempt
// before this function is even reached, and again here by the DB's
// unique index on ba_id if something raced past that check.
// ---------------------------------------------------------------------
async function submitPaymentDetails({ token, email, mpesaNumber, submittedName }) {
  const tokenCheck = await validateSubmissionAttempt(token);
  if (!tokenCheck.ok) {
    const err = new Error(tokenCheck.error);
    if (tokenCheck.duplicate) err.duplicate = true;
    else err.linkInvalid = true;
    throw err;
  }
  const ba = tokenCheck.ba;

  if (ba.status !== 'active' && ba.status !== 'suspended') {
    const err = new Error(
      "This Brand Ambassador account isn't active. Please contact RentaPay if you believe this is a mistake."
    );
    err.baNotFound = true;
    throw err;
  }

  // The account email typed on the form must match the BA this token
  // belongs to - the token alone identifies the BA, the email is a
  // confirmation step, not a second lookup path.
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (normalizedEmail !== String(ba.email || '').toLowerCase()) {
    const err = new Error(
      "That email address doesn't match the Brand Ambassador account this link belongs to. Please double-check it."
    );
    err.validation = true;
    throw err;
  }

  const { normalizedMpesa, normalizedName } = assertDetailsValid({ mpesaNumber, submittedName });

  const { data, error } = await supabase
    .from('ba_payment_submissions')
    .insert({
      ba_id: ba.id,
      mpesa_number: normalizedMpesa,
      submitted_name: normalizedName,
      submitted_email: normalizedEmail,
      submitted_at: new Date().toISOString(),
      status: 'on_file',
    })
    .select()
    .single();
  if (error) {
    // Unique-violation on ba_id = a race slipped past the token check
    // above (e.g. a double-click firing two requests). Never silently
    // overwrite - reject with the same duplicate-submission error.
    if (error.code === '23505') {
      const dupErr = new Error(
        'This payment details link has already been used. Each Brand Ambassador can only submit once.'
      );
      dupErr.duplicate = true;
      throw dupErr;
    }
    logger.error('[baPaymentSubmission] submitPaymentDetails insert error:', error.message);
    throw error;
  }

  // Close the submission channel permanently - automatic, no admin step.
  await markSubmissionUsed(ba.id);

  return { submission: data, ba };
}

// ---------------------------------------------------------------------
// The ONLY correction path: a valid, unexpired, unused 24h edit link
// issued by an admin. Updates the BA's single on-file row in place -
// this is a deliberate admin-triggered correction, never a BA-side
// resubmission.
// ---------------------------------------------------------------------
async function applyEdit({ editToken, mpesaNumber, submittedName, email }) {
  const linkCheck = await validateEditLink(editToken);
  if (!linkCheck.ok) {
    const err = new Error(linkCheck.error);
    err.linkInvalid = true;
    throw err;
  }
  const { link, ba } = linkCheck;

  const { normalizedMpesa, normalizedName } = assertDetailsValid({ mpesaNumber, submittedName });
  const normalizedEmail = email ? String(email).trim().toLowerCase() : undefined;

  const updatePayload = {
    mpesa_number: normalizedMpesa,
    submitted_name: normalizedName,
    submitted_at: new Date().toISOString(),
  };
  if (normalizedEmail) updatePayload.submitted_email = normalizedEmail;

  const { data, error } = await supabase
    .from('ba_payment_submissions')
    .update(updatePayload)
    .eq('ba_id', ba.id)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('No on-file submission was found to edit for this Brand Ambassador.');
    err.notFound = true;
    throw err;
  }

  await markEditLinkUsed(link.id);

  return { submission: data, ba };
}

// ---------------------------------------------------------------------
// Lets the BA (or the edit flow) look their own on-file submission
// back up. Scoped strictly to the BA identified by the token.
// ---------------------------------------------------------------------
async function getMySubmission({ token, editToken, email }) {
  let baId;
  if (editToken) {
    const linkCheck = await validateEditLink(editToken);
    if (!linkCheck.ok) {
      const err = new Error(linkCheck.error);
      err.linkInvalid = true;
      throw err;
    }
    baId = linkCheck.ba.id;
  } else {
    const ba = await findPayableBaByEmail(email);
    if (!ba) return null;
    if (!token || ba.payout_submission_token !== String(token)) return null;
    baId = ba.id;
  }

  const { data, error } = await supabase
    .from('ba_payment_submissions')
    .select('*')
    .eq('ba_id', baId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = {
  findPayableBaByEmail,
  submitPaymentDetails,
  applyEdit,
  getMySubmission,
};
