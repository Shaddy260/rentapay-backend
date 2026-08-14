// src/services/baPaymentSubmission.service.js
//
// BA Monthly Payment Details & Payout Workflow - Phase 2.
//
// Owns the write/read path for `ba_payment_submissions` rows created
// from the PUBLIC submission form (Phase 2 controller). Phase 3/4
// (admin Pending/Completed views, mark-as-paid, PDF export) are not
// implemented here - this file only covers:
//   - looking up the BA by account email (unique match, no fuzzy match
//     per the plan's "Matching" decision)
//   - upserting into ba_payment_submissions for the CURRENT active
//     cycle, overwriting any earlier submission this BA made this
//     month (unique constraint on (cycle_id, ba_id) - see Phase 1 SQL)
//   - letting the BA look their own submission back up within the
//     same month, so the confirmation view can support "see/edit
//     later" per the plan's Phase 2 note

const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { normalizePhoneOrThrow } = require('../utils/phone');
const { validateSubmissionToken } = require('./baPayoutLinkCycle.service');

// ---------------------------------------------------------------------
// Look up an active Brand Ambassador by their account email. Only
// 'active' BAs are payable via this flow - a pending/rejected/
// suspended/inactive account has no business submitting payout
// details. Matching is by email, case-insensitive, exact (no fuzzy
// matching per the plan).
// ---------------------------------------------------------------------
async function findPayableBaByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from('brand_ambassadors')
    .select('id, full_name, email, status')
    .ilike('email', normalized)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return data;
}

// ---------------------------------------------------------------------
// Upsert the BA's payment details for the current month's active
// cycle. Resubmission overwrites in place (same cycle_id + ba_id row,
// per the unique constraint) - no history of prior mistaken entries
// is kept, per the plan's "Resubmission: overwrite" decision.
// ---------------------------------------------------------------------
async function submitPaymentDetails({ token, email, mpesaNumber, submittedName }) {
  const tokenCheck = await validateSubmissionToken(token);
  if (!tokenCheck.ok) {
    const err = new Error(tokenCheck.error);
    err.linkInvalid = true;
    throw err;
  }
  const cycle = tokenCheck.cycle;

  const ba = await findPayableBaByEmail(email);
  if (!ba || ba.status !== 'active') {
    const err = new Error(
      "We couldn't find an active Brand Ambassador account for that email address. Please double-check it, or contact RentaPay if you believe this is a mistake."
    );
    err.baNotFound = true;
    throw err;
  }

  const normalizedMpesa = normalizePhoneOrThrow(mpesaNumber, 'M-Pesa number');
  const normalizedName = String(submittedName || '').trim();
  if (!normalizedName) {
    const err = new Error('Please enter the name registered on this M-Pesa number.');
    err.validation = true;
    throw err;
  }
  const normalizedEmail = String(email).trim().toLowerCase();

  const { data, error } = await supabase
    .from('ba_payment_submissions')
    .upsert(
      {
        cycle_id: cycle.id,
        ba_id: ba.id,
        mpesa_number: normalizedMpesa,
        submitted_name: normalizedName,
        submitted_email: normalizedEmail,
        submitted_at: new Date().toISOString(),
        status: 'pending',
      },
      { onConflict: 'cycle_id,ba_id' }
    )
    .select()
    .single();
  if (error) {
    logger.error('[baPaymentSubmission] submitPaymentDetails upsert error:', error.message);
    throw error;
  }

  return { submission: data, cycle, ba };
}

// ---------------------------------------------------------------------
// Lets the BA look their own current-month submission back up (e.g.
// the confirmation view re-opened later) - looks up by the same email
// within the current active cycle only. Never exposes other BAs'
// rows; scoped to (currentCycle, ba matching this email).
// ---------------------------------------------------------------------
async function getMySubmission({ token, email }) {
  const tokenCheck = await validateSubmissionToken(token);
  if (!tokenCheck.ok) {
    const err = new Error(tokenCheck.error);
    err.linkInvalid = true;
    throw err;
  }
  const cycle = tokenCheck.cycle;

  const ba = await findPayableBaByEmail(email);
  if (!ba) return null;

  const { data, error } = await supabase
    .from('ba_payment_submissions')
    .select('*')
    .eq('cycle_id', cycle.id)
    .eq('ba_id', ba.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = {
  findPayableBaByEmail,
  submitPaymentDetails,
  getMySubmission,
};
