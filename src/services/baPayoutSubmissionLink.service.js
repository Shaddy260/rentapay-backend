// src/services/baPayoutSubmissionLink.service.js
//
// BUILD SPEC PHASE 10 - Fix: BA Payout Submission Overwrite Bug.
//
// Owns the one-time, non-expiring, single-use BA payment-details
// submission channel, plus the separate 24h admin-issued edit link
// that is now the ONLY path back into a BA's details after their one
// submission. Replaces the old per-calendar-month
// baPayoutLinkCycle.service token entirely for gating purposes - that
// service's period_key concept is still used elsewhere purely to
// group ba_commission_earnings by month, which is unrelated to this.

const crypto = require('crypto');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rentapay.co.ke';
const EDIT_LINK_TTL_HOURS = 24;

function generateToken() {
  return crypto.randomBytes(20).toString('hex');
}

function submissionLinkForToken(token) {
  return `${FRONTEND_URL}/ba-payout-submit?token=${token}`;
}

function editLinkForToken(token) {
  return `${FRONTEND_URL}/ba-payout-submit?edit=${token}`;
}

// ---------------------------------------------------------------------
// Called once at BA approval (see approveBaApplication) to establish
// the BA's one-time submission channel. Never called again for that
// BA afterwards - there is no "regenerate" for this token, per the
// plan ("this submission link does not expire on its own").
// ---------------------------------------------------------------------
async function issueSubmissionToken(baId) {
  const token = generateToken();
  const { error } = await supabase
    .from('brand_ambassadors')
    .update({ payout_submission_token: token, payout_submission_token_generated_at: new Date().toISOString() })
    .eq('id', baId);
  if (error) throw error;
  return token;
}

// ---------------------------------------------------------------------
// Validates a submission (?token=) attempt server-side. This is the
// real guard against duplicate/resubmission attempts (old link,
// bookmark, replay) - it is never bypassed by anything client-side.
// ---------------------------------------------------------------------
async function validateSubmissionAttempt(token) {
  if (!token) {
    return { ok: false, error: 'This payment details link is invalid.' };
  }
  const { data: ba, error } = await supabase
    .from('brand_ambassadors')
    .select('id, full_name, status, payout_submission_token, payout_submission_used_at')
    .eq('payout_submission_token', String(token))
    .maybeSingle();
  if (error) throw error;

  if (!ba) {
    return { ok: false, error: 'This payment details link is invalid.' };
  }
  if (ba.payout_submission_used_at) {
    return {
      ok: false,
      duplicate: true,
      error:
        'This payment details link has already been used. Each Brand Ambassador can only submit once - if your details need to change, please ask RentaPay admin for a correction link.',
    };
  }
  return { ok: true, ba };
}

// ---------------------------------------------------------------------
// Permanently closes the BA's submission channel the moment their
// one-time submission succeeds - no manual admin step required.
// ---------------------------------------------------------------------
async function markSubmissionUsed(baId) {
  const { error } = await supabase
    .from('brand_ambassadors')
    .update({ payout_submission_used_at: new Date().toISOString() })
    .eq('id', baId)
    .is('payout_submission_used_at', null);
  if (error) throw error;
}

// ---------------------------------------------------------------------
// ADMIN - generate a 24h, single-use edit link for a BA who has
// already submitted once. This is the ONLY route back into their
// details; there is no resubmission UI or path anywhere else.
// ---------------------------------------------------------------------
async function generateEditLink({ baId, adminId }) {
  const { data: ba, error: baErr } = await supabase
    .from('brand_ambassadors')
    .select('id, payout_submission_used_at')
    .eq('id', baId)
    .maybeSingle();
  if (baErr) throw baErr;
  if (!ba) {
    const err = new Error('Brand Ambassador not found.');
    err.notFound = true;
    throw err;
  }
  if (!ba.payout_submission_used_at) {
    const err = new Error('This Brand Ambassador has not submitted payment details yet - no edit link is needed.');
    err.validation = true;
    throw err;
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + EDIT_LINK_TTL_HOURS * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('ba_payout_edit_links')
    .insert({ ba_id: baId, token, created_by_admin_id: adminId || null, expires_at: expiresAt.toISOString() })
    .select()
    .single();
  if (error) throw error;

  return { link: editLinkForToken(token), expiresAt: data.expires_at };
}

// ---------------------------------------------------------------------
// Validates an edit-link (?edit=) attempt - must exist, be unused, and
// not yet expired (24h from issue).
// ---------------------------------------------------------------------
async function validateEditLink(token) {
  if (!token) {
    return { ok: false, error: 'This edit link is invalid.' };
  }
  const { data: link, error } = await supabase
    .from('ba_payout_edit_links')
    .select('id, ba_id, expires_at, used_at')
    .eq('token', String(token))
    .maybeSingle();
  if (error) throw error;

  if (!link) {
    return { ok: false, error: 'This edit link is invalid.' };
  }
  if (link.used_at) {
    return { ok: false, error: 'This edit link has already been used. Please ask RentaPay admin for a new one.' };
  }
  if (new Date(link.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'This edit link has expired (edit links are valid for 24 hours). Please ask RentaPay admin for a new one.' };
  }

  const { data: ba, error: baErr } = await supabase
    .from('brand_ambassadors')
    .select('id, full_name, status')
    .eq('id', link.ba_id)
    .maybeSingle();
  if (baErr) throw baErr;
  if (!ba) {
    return { ok: false, error: 'This edit link is invalid.' };
  }

  return { ok: true, link, ba };
}

async function markEditLinkUsed(linkId) {
  const { error } = await supabase
    .from('ba_payout_edit_links')
    .update({ used_at: new Date().toISOString() })
    .eq('id', linkId)
    .is('used_at', null);
  if (error) throw error;
}

module.exports = {
  submissionLinkForToken,
  editLinkForToken,
  issueSubmissionToken,
  validateSubmissionAttempt,
  markSubmissionUsed,
  generateEditLink,
  validateEditLink,
  markEditLinkUsed,
  EDIT_LINK_TTL_HOURS,
};
