// src/services/baPaymentSubmission.service.js
//
// BUILD SPEC PHASE 10 (v2) - Universal BA Payout Links + Email/OTP Gate.
//
// Owns the write/read path for `ba_payment_submissions` - exactly ONE
// row per BA, ever, capturing their M-Pesa/name/email on file.
//
//   - submitPaymentDetails() - the one-time submission, authorized by
//     a verificationToken minted by baPayoutSubmissionLink.verifyOtp
//     (purpose 'submit'). Plain INSERT, never an upsert - there is no
//     overwrite path here at all. Belt-and-braces: the unique index on
//     ba_id means even a race can't produce two rows for one BA.
//   - applyEdit() - the ONLY way to change an on-file submission after
//     the fact, authorized by a verificationToken minted against the
//     current 24h admin-issued edit link (purpose 'edit').
//   - getMySubmission() - lets a verified BA look their own on-file
//     details back up.
//
// Payout PAID/PENDING status does not live here at all - see
// baPendingPayouts.service.js / baCompletedPayouts.service.js, which
// read/write ba_payouts instead. A completed payout can never be
// affected by anything in this file.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { normalizePhoneOrThrow } = require('../utils/phone');
const {
  resolveVerificationToken,
  markVerificationConsumed,
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
// The ONE-TIME submission. No resubmission path exists here: once
// this succeeds, the BA's payout_submission_used_at is stamped and the
// channel is permanently closed - any further attempt is rejected
// outright, both by resolveVerificationToken (eligibility re-checked)
// and again here by the DB's unique index on ba_id if something raced
// past that check.
// ---------------------------------------------------------------------
async function submitPaymentDetails({ verificationToken, mpesaNumber, submittedName }) {
  const { ba, otpRecordId } = await resolveVerificationToken({ verificationToken, purpose: 'submit' });

  const { normalizedMpesa, normalizedName } = assertDetailsValid({ mpesaNumber, submittedName });

  const { data, error } = await supabase
    .from('ba_payment_submissions')
    .insert({
      ba_id: ba.id,
      mpesa_number: normalizedMpesa,
      submitted_name: normalizedName,
      submitted_email: String(ba.email || '').toLowerCase(),
      submitted_at: new Date().toISOString(),
      status: 'on_file',
    })
    .select()
    .single();
  if (error) {
    // Unique-violation on ba_id = a race slipped past the eligibility
    // check above (e.g. a double-click firing two requests). Never
    // silently overwrite - reject with the same duplicate-submission
    // error.
    if (error.code === '23505') {
      const dupErr = new Error(
        'This payout link has already been used. Each Brand Ambassador can only submit once.'
      );
      dupErr.duplicate = true;
      throw dupErr;
    }
    logger.error('[baPaymentSubmission] submitPaymentDetails insert error:', error.message);
    throw error;
  }

  // Close the submission channel permanently - automatic, no admin step.
  await supabase
    .from('brand_ambassadors')
    .update({ payout_submission_used_at: new Date().toISOString() })
    .eq('id', ba.id)
    .is('payout_submission_used_at', null);

  await markVerificationConsumed(otpRecordId);

  return { submission: data, ba };
}

// ---------------------------------------------------------------------
// The ONLY correction path: a verificationToken minted against the
// current, unexpired 24h admin-issued edit link. Updates the BA's
// single on-file row in place - this is a deliberate admin-enabled
// correction, never a BA-side resubmission.
// ---------------------------------------------------------------------
async function applyEdit({ verificationToken, mpesaNumber, submittedName }) {
  const { ba, otpRecordId } = await resolveVerificationToken({ verificationToken, purpose: 'edit' });

  const { normalizedMpesa, normalizedName } = assertDetailsValid({ mpesaNumber, submittedName });

  const { data, error } = await supabase
    .from('ba_payment_submissions')
    .update({
      mpesa_number: normalizedMpesa,
      submitted_name: normalizedName,
      submitted_at: new Date().toISOString(),
    })
    .eq('ba_id', ba.id)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('No on-file submission was found to edit for this Brand Ambassador.');
    err.notFound = true;
    throw err;
  }

  await markVerificationConsumed(otpRecordId);

  return { submission: data, ba };
}

// ---------------------------------------------------------------------
// Lets a verified BA look their own on-file submission back up, using
// the same short-lived verificationToken issued by verifyOtp (either
// purpose) rather than a bare email - so this can't be used to probe
// other BAs' details.
// ---------------------------------------------------------------------
async function getMySubmission({ verificationToken, purpose }) {
  const { ba } = await resolveVerificationToken({ verificationToken, purpose: purpose || 'edit' });

  const { data, error } = await supabase
    .from('ba_payment_submissions')
    .select('*')
    .eq('ba_id', ba.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = {
  submitPaymentDetails,
  applyEdit,
  getMySubmission,
};
