// src/services/baPayoutLinkCycle.service.js
//
// BA Monthly Payment Details & Payout Workflow - Phase 1.
//
// Owns the lifecycle of `ba_payout_link_cycles` rows: one row per
// calendar month, each carrying the public submission token for that
// month. "New month = new cycle, automatically" is implemented
// lazily - there is no cron job here. Whenever anything asks for
// "the current cycle" (admin viewing the link status, the public form
// loading), getOrCreateCurrentCycle() checks the current month's
// period_key and creates the row on first touch if it doesn't exist
// yet, and opportunistically flips any older 'active' cycle to
// 'closed' at the same time. Closing is purely a status label - it
// never deletes or blocks access to a cycle's still-unpaid
// ba_payment_submissions rows (Phase 3 reads across every cycle with
// unpaid entries, not just the active one).
//
// Token shape mirrors the existing ba_onboarding_links convention in
// brandAmbassador.controller.js (crypto.randomBytes(...).toString('hex')),
// reused here for consistency rather than inventing a new format.

const crypto = require('crypto');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rentapay.co.ke';

function currentPeriodKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function generateCycleToken() {
  return crypto.randomBytes(20).toString('hex');
}

function publicLinkForToken(token) {
  return `${FRONTEND_URL}/ba-payout-submit?token=${token}`;
}

// ---------------------------------------------------------------------
// Flips any 'active' cycle whose period_key isn't the current month to
// 'closed'. Best-effort/idempotent - safe to call as often as needed.
// Never touches ba_payment_submissions.
// ---------------------------------------------------------------------
async function closeStaleActiveCycles() {
  const period = currentPeriodKey();
  const { error } = await supabase
    .from('ba_payout_link_cycles')
    .update({ status: 'closed' })
    .eq('status', 'active')
    .neq('period_key', period);
  if (error) {
    logger.error('[baPayoutLinkCycle] closeStaleActiveCycles error:', error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------
// Returns the current calendar month's cycle row, creating it (with a
// fresh token) on first touch if it doesn't exist yet. Also closes out
// any stale active cycle from a prior month in the same call, so
// "current cycle" and "only one active cycle at a time" stay in sync
// without a scheduled job.
// ---------------------------------------------------------------------
async function getOrCreateCurrentCycle(adminId = null) {
  const period = currentPeriodKey();

  await closeStaleActiveCycles();

  const { data: existing, error: fetchErr } = await supabase
    .from('ba_payout_link_cycles')
    .select('*')
    .eq('period_key', period)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (existing) return existing;

  const { data: created, error: insertErr } = await supabase
    .from('ba_payout_link_cycles')
    .insert({
      token: generateCycleToken(),
      period_key: period,
      generated_by_admin_id: adminId,
      generated_at: new Date().toISOString(),
      status: 'active',
    })
    .select()
    .single();
  if (insertErr) {
    // Race: another request created the same period_key between our
    // fetch and insert (unique constraint on period_key). Re-fetch
    // rather than erroring the caller.
    if (insertErr.code === '23505') {
      const { data: retried, error: retryErr } = await supabase
        .from('ba_payout_link_cycles')
        .select('*')
        .eq('period_key', period)
        .maybeSingle();
      if (retryErr) throw retryErr;
      if (retried) return retried;
    }
    throw insertErr;
  }
  return created;
}

// ---------------------------------------------------------------------
// Public token validation - used by the Phase 2 submission form to
// confirm a link belongs to a real, still-relevant cycle before
// rendering. Any cycle (active OR closed) with a matching token is
// accepted for READ purposes elsewhere, but the public submission
// form itself should only stay open for the active month, per "No
// link expiry ... stays valid for the whole month it belongs to" -
// i.e. once the month rolls over the old token simply stops matching
// the new active cycle and should be treated as no-longer-submittable.
// ---------------------------------------------------------------------
async function validateSubmissionToken(token) {
  if (!token) {
    return { ok: false, error: 'This payment details link is invalid.' };
  }
  const current = await getOrCreateCurrentCycle();
  if (current.token !== String(token)) {
    return { ok: false, error: 'This payment details link is no longer active. Please ask RentaPay for the current link.' };
  }
  return { ok: true, cycle: current };
}

module.exports = {
  currentPeriodKey,
  generateCycleToken,
  publicLinkForToken,
  closeStaleActiveCycles,
  getOrCreateCurrentCycle,
  validateSubmissionToken,
};
