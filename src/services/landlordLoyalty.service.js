// src/services/landlordLoyalty.service.js
//
// Detects landlords who have paid for consecutive subscription
// periods back-to-back (no gap) up to today, and lets an admin
// bulk-grant a discount percentage to some or all of them. The
// granted discount is stored per landlord (landlord_loyalty_discounts)
// and is read back automatically the next time that landlord's
// subscription cost is calculated - see utils/pricing.js.

const supabase = require('../config/supabase');
const { notify } = require('./notify.service');
const logger = require('../utils/logger');

// A short grace window between one paid period ending and the next
// payment landing - covers the landlord renewing a day or two early
// or late without breaking their "consecutive" streak.
const GRACE_DAYS = 10;
const DEFAULT_MIN_CONSECUTIVE_MONTHS = 4;

// P2 (roadmap): "after a landlord renews subscription with the
// discount... it should expire unless given another one" - a grant
// used to sit active forever with no urgency. Default window applied
// to a new grant unless the admin overrides it per-batch when granting.
const DEFAULT_DISCOUNT_EXPIRY_DAYS = 30;

// Every read of "is this discount active" needs to also treat an
// expired-but-still-is_active row as inactive - a scheduled sweep
// (loyaltyDiscountExpiry.job.js) eventually flips is_active to false
// for these too, but reads shouldn't have to wait on that job to run.
// A null expires_at (grants made before this column existed) never
// expires.
function notExpiredFilter(query, nowIso) {
  return query.or(`expires_at.is.null,expires_at.gt.${nowIso}`);
}

/**
 * Walks a landlord's completed subscription payments in order and
 * returns the length (in months) of their CURRENT unbroken streak -
 * i.e. the streak that is still running today. Returns 0 if their
 * subscription has lapsed or they've never paid.
 */
function computeConsecutiveMonths(payments, asOf = new Date()) {
  const sorted = [...payments]
    .filter((p) => p.status === 'completed' && p.paid_at)
    .sort((a, b) => new Date(a.paid_at) - new Date(b.paid_at));

  if (sorted.length === 0) return { months: 0, coverageEnd: null, streakStart: null };

  let streakMonths = 0;
  let coverageEnd = null;
  let streakStart = null;

  for (const payment of sorted) {
    const paidAt = new Date(payment.paid_at);
    const periodMonths = Number(payment.period_months) || 0;
    const periodEnd = new Date(paidAt);
    periodEnd.setMonth(periodEnd.getMonth() + periodMonths);

    const graceMs = GRACE_DAYS * 24 * 60 * 60 * 1000;
    const continuesStreak = coverageEnd && paidAt.getTime() <= coverageEnd.getTime() + graceMs;

    if (continuesStreak) {
      streakMonths += periodMonths;
      coverageEnd = periodEnd > coverageEnd ? periodEnd : coverageEnd;
    } else {
      // Gap found (or this is the first payment) - streak restarts here.
      streakMonths = periodMonths;
      coverageEnd = periodEnd;
      streakStart = paidAt;
    }
  }

  // The streak only counts if it's still running as of today - a
  // landlord whose last streak ended months ago isn't "currently
  // consecutive" even if it was once long.
  const graceMs = GRACE_DAYS * 24 * 60 * 60 * 1000;
  const stillRunning = coverageEnd && coverageEnd.getTime() + graceMs >= asOf.getTime();

  return { months: stillRunning ? streakMonths : 0, coverageEnd, streakStart };
}

/**
 * Finds every landlord whose current unbroken subscription streak is
 * at least `minMonths` long, and who does not already have an active
 * loyalty discount granted for a streak this long or longer (so
 * re-running detection doesn't keep re-flagging landlords who were
 * already rewarded for the months they've clocked up so far).
 */
async function findConsecutiveLandlordCandidates(minMonths = DEFAULT_MIN_CONSECUTIVE_MONTHS) {
  const { data: landlords, error: landlordsErr } = await supabase
    .from('landlords')
    .select('id, full_name, email, phone, subscription_status')
    .neq('subscription_status', 'pending');
  if (landlordsErr) throw landlordsErr;

  const { data: payments, error: paymentsErr } = await supabase
    .from('subscription_payments')
    .select('landlord_id, period_months, paid_at, status, amount')
    .eq('status', 'completed');
  if (paymentsErr) throw paymentsErr;

  let activeDiscountsQuery = supabase
    .from('landlord_loyalty_discounts')
    .select('landlord_id, consecutive_months_at_grant')
    .eq('is_active', true);
  activeDiscountsQuery = notExpiredFilter(activeDiscountsQuery, new Date().toISOString());
  const { data: activeDiscounts, error: discErr } = await activeDiscountsQuery;
  if (discErr) throw discErr;

  const activeDiscountByLandlord = new Map((activeDiscounts || []).map((d) => [d.landlord_id, d]));

  const paymentsByLandlord = new Map();
  for (const p of payments || []) {
    if (!paymentsByLandlord.has(p.landlord_id)) paymentsByLandlord.set(p.landlord_id, []);
    paymentsByLandlord.get(p.landlord_id).push(p);
  }

  const candidates = [];
  for (const landlord of landlords || []) {
    const landlordPayments = paymentsByLandlord.get(landlord.id) || [];
    if (landlordPayments.length === 0) continue;

    const { months } = computeConsecutiveMonths(landlordPayments);
    if (months < minMonths) continue;

    const existingGrant = activeDiscountByLandlord.get(landlord.id);
    // Skip landlords already rewarded for at least this many months -
    // they'll resurface once they clock up more months than their
    // last grant covered.
    if (existingGrant && Number(existingGrant.consecutive_months_at_grant) >= months) continue;

    candidates.push({
      landlordId: landlord.id,
      fullName: landlord.full_name,
      email: landlord.email,
      phone: landlord.phone,
      consecutiveMonths: months,
      alreadyHasDiscount: !!existingGrant,
    });
  }

  candidates.sort((a, b) => b.consecutiveMonths - a.consecutiveMonths);
  return candidates;
}

/**
 * Bulk-grants the same discount percentage to a list of landlords.
 * Any existing active grant for a landlord is deactivated first (only
 * one active grant per landlord - enforced by the DB unique index
 * too), so a re-grant cleanly supersedes rather than stacks.
 */
async function bulkGrantLoyaltyDiscount({ landlordIds, discountPercentage, adminId, note, expiryDays }) {
  if (!Array.isArray(landlordIds) || landlordIds.length === 0) {
    throw new Error('landlordIds must be a non-empty array.');
  }
  const pct = Number(discountPercentage);
  if (Number.isNaN(pct) || pct < 0 || pct > 100) {
    throw new Error('discountPercentage must be between 0 and 100.');
  }

  // P2: admin-configurable per batch, defaults to 30 days.
  let expiryDaysResolved = DEFAULT_DISCOUNT_EXPIRY_DAYS;
  if (expiryDays != null && expiryDays !== '') {
    const parsed = Number(expiryDays);
    if (Number.isNaN(parsed) || parsed < 1) {
      throw new Error('expiryDays must be a whole number of days, 1 or more.');
    }
    expiryDaysResolved = parsed;
  }
  const expiresAt = new Date(Date.now() + expiryDaysResolved * 24 * 60 * 60 * 1000).toISOString();

  const batchId = require('crypto').randomUUID();
  const results = [];
  const errors = [];

  // Need each landlord's current consecutive-months figure to record
  // alongside the grant (for the "already rewarded" skip logic above).
  const candidates = await findConsecutiveLandlordCandidates(0);
  const monthsById = new Map(candidates.map((c) => [c.landlordId, c.consecutiveMonths]));

  for (const landlordId of landlordIds) {
    try {
      const { error: deactivateErr } = await supabase
        .from('landlord_loyalty_discounts')
        .update({ is_active: false, revoked_at: new Date().toISOString(), revoked_by_admin_id: adminId || 'super-admin' })
        .eq('landlord_id', landlordId)
        .eq('is_active', true);
      if (deactivateErr) throw deactivateErr;

      const { data: saved, error: insertErr } = await supabase
        .from('landlord_loyalty_discounts')
        .insert({
          landlord_id: landlordId,
          discount_percentage: pct,
          consecutive_months_at_grant: monthsById.get(landlordId) || 0,
          batch_id: batchId,
          is_active: true,
          note: note || null,
          granted_by_admin_id: adminId || 'super-admin',
          expires_at: expiresAt,
        })
        .select()
        .single();
      if (insertErr) throw insertErr;

      results.push(saved);

      // IN-APP + PUSH NOTIFICATION ON GRANT (direct request: "should be
      // sending such landlords... there is a discount... should be in
      // app and popup not email"): notify() already defaults to
      // in-app inbox + OS push with email OFF (allowEmail not passed),
      // which is exactly the "no email" requirement here. Deliberately
      // not awaited inline with the grant loop below it - a slow/down
      // delivery channel for one landlord should never delay granting
      // the discount to the rest of the batch.
      const candidate = candidates.find((c) => c.landlordId === landlordId);
      notify(
        'landlord',
        landlordId,
        candidate?.phone,
        `You've been granted a ${pct}% loyalty discount on your next subscription renewal. It'll apply automatically the next time you renew - use it within ${expiryDaysResolved} days before it expires.`,
        { category: 'account', title: 'Loyalty Discount Granted' }
      ).catch((notifyErr) => {
        logger.warn(`[landlordLoyalty] grant notify failed for landlord ${landlordId}:`, notifyErr.message);
      });
    } catch (err) {
      logger.error(`[landlordLoyalty] failed to grant discount to landlord ${landlordId}:`, err.message);
      errors.push({ landlordId, error: err.message });
    }
  }

  return { batchId, granted: results, errors };
}

async function revokeLoyaltyDiscount(landlordId, adminId) {
  const { data, error } = await supabase
    .from('landlord_loyalty_discounts')
    .update({ is_active: false, revoked_at: new Date().toISOString(), revoked_by_admin_id: adminId || 'super-admin' })
    .eq('landlord_id', landlordId)
    .eq('is_active', true)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Returns the active discount percentage for one landlord (0 if
 * none), used by pricing.js at charge time. This is what makes a
 * granted discount "remembered" for the landlord's next subscription
 * payment - signup is the one flow that never passes a landlordId
 * here since a brand-new account can't have a grant yet.
 */
async function getActiveDiscountForLandlord(landlordId) {
  if (!landlordId) return 0;
  let query = supabase
    .from('landlord_loyalty_discounts')
    .select('discount_percentage')
    .eq('landlord_id', landlordId)
    .eq('is_active', true);
  query = notExpiredFilter(query, new Date().toISOString());
  const { data, error } = await query.maybeSingle();
  if (error) {
    logger.error('[landlordLoyalty] failed to look up active discount:', error.message);
    return 0;
  }
  return data ? Number(data.discount_percentage) : 0;
}

/**
 * Same lookup as getActiveDiscountForLandlord, but returns the full
 * row (id included) rather than just the percentage. Used at the
 * moment a renewal is INITIATED (Daraja/STK renewSubscription, or a
 * manual-payment submission) so the id of whichever discount is
 * currently active can be captured on the payment row itself - that
 * captured id is what gets consumed later, on confirmed completion,
 * instead of re-resolving "whatever is active right now" (which could
 * have changed, or been consumed by a different in-flight payment, by
 * the time the callback lands).
 */
async function getActiveDiscountRecordForLandlord(landlordId) {
  if (!landlordId) return null;
  let query = supabase
    .from('landlord_loyalty_discounts')
    .select('id, discount_percentage')
    .eq('landlord_id', landlordId)
    .eq('is_active', true);
  query = notExpiredFilter(query, new Date().toISOString());
  const { data, error } = await query.maybeSingle();
  if (error) {
    logger.error('[landlordLoyalty] failed to look up active discount record:', error.message);
    return null;
  }
  return data || null;
}

/**
 * ONE-TIME DISCOUNT CONSUMPTION (direct request: "after a landlord
 * renews subscription with the discount... it should expire unless
 * given another one"). Called only once a renewal payment that had
 * this discount attached at initiation is CONFIRMED complete - never
 * on a failed/abandoned STK push, so a landlord doesn't lose their
 * discount to a payment that never went through. Deactivates the
 * discount (so it stops applying to the NEXT renewal) and stamps
 * consumed_at plus whichever payment row consumed it, for audit.
 *
 * Idempotent/defensive: a no-op if the discount is already inactive
 * (e.g. a duplicate callback retry), and never throws - consuming a
 * discount is bookkeeping, it should never block the renewal itself
 * from completing.
 */
async function consumeLoyaltyDiscount(discountId, { subscriptionPaymentId = null, manualPaymentId = null, propertyPaymentId = null } = {}) {
  if (!discountId) return null;
  try {
    const { data, error } = await supabase
      .from('landlord_loyalty_discounts')
      .update({
        is_active: false,
        consumed_at: new Date().toISOString(),
        consumed_by_subscription_payment_id: subscriptionPaymentId,
        consumed_by_manual_payment_id: manualPaymentId,
        consumed_by_property_payment_id: propertyPaymentId,
      })
      .eq('id', discountId)
      .eq('is_active', true)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  } catch (err) {
    logger.error(`[landlordLoyalty] failed to consume discount ${discountId}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// REMINDER POPUP (direct request: "should be sending such landlords
// whose subscription is not ended that there is a discount to their
// next renewal... reminding them... should be in app and popup not
// email") - surfaces a landlord's still-active, not-yet-consumed
// discount as a dismissible popup, same snooze pattern as
// RateTenantReminderPopup/tenantRatingReminder.service.js.
// ---------------------------------------------------------------------

const SNOOZE_LATER_MS = 60 * 60 * 1000; // "Remind me later" - ~1 hour

/**
 * Returns the reminder to show this landlord right now, or null if
 * there's nothing to remind them about (no active discount, or it's
 * currently snoozed). Does NOT check subscription status itself -
 * that's the caller's job (subscription.controller.js), since only it
 * knows whether it's checking the landlord-wide status or a specific
 * property's own clock.
 */
async function getReminderForLandlord(landlordId) {
  if (!landlordId) return null;
  const nowIso = new Date().toISOString();
  let query = supabase
    .from('landlord_loyalty_discounts')
    .select('id, discount_percentage, granted_at, reminder_snoozed_until, expires_at')
    .eq('landlord_id', landlordId)
    .eq('is_active', true);
  query = notExpiredFilter(query, nowIso);
  const { data, error } = await query.maybeSingle();
  if (error) {
    logger.error('[landlordLoyalty] failed to look up reminder:', error.message);
    return null;
  }
  if (!data) return null;

  if (data.reminder_snoozed_until && new Date(data.reminder_snoozed_until).getTime() > Date.now()) {
    return null;
  }

  // P2: "expires in N days" copy once close to expiry - null when the
  // grant has no expiry (pre-migration rows).
  let daysUntilExpiry = null;
  if (data.expires_at) {
    daysUntilExpiry = Math.max(0, Math.ceil((new Date(data.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  }

  return {
    discountId: data.id,
    discountPercentage: Number(data.discount_percentage),
    grantedAt: data.granted_at,
    expiresAt: data.expires_at,
    daysUntilExpiry,
  };
}

/**
 * mode: 'later' snoozes ~1 hour, 'not_today' snoozes until the start
 * of tomorrow - same two options/semantics as the rate-tenant popup.
 */
async function snoozeReminder(discountId, mode) {
  const now = new Date();
  let snoozeUntil;
  if (mode === 'not_today') {
    const tomorrow = new Date(now);
    tomorrow.setHours(24, 0, 0, 0);
    snoozeUntil = tomorrow;
  } else {
    snoozeUntil = new Date(now.getTime() + SNOOZE_LATER_MS);
  }

  const { error } = await supabase
    .from('landlord_loyalty_discounts')
    .update({ reminder_snoozed_until: snoozeUntil.toISOString() })
    .eq('id', discountId)
    .eq('is_active', true);
  if (error) {
    logger.error(`[landlordLoyalty] failed to snooze reminder ${discountId}:`, error.message);
  }
}

async function listActiveDiscounts() {
  let query = supabase
    .from('landlord_loyalty_discounts')
    .select('*, landlords(full_name, email, phone)')
    .eq('is_active', true)
    .order('granted_at', { ascending: false });
  query = notExpiredFilter(query, new Date().toISOString());
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ---------------------------------------------------------------------
// P4 (roadmap): "Admin visibility / audit trail - only shows currently-
// active grants. No view of consumed/revoked history, which payment
// consumed which discount, or reminder-snooze activity." Unlike
// listActiveDiscounts above (which filters down to what's usable RIGHT
// NOW), this returns every grant a landlord has ever had - active,
// consumed, revoked, or lapsed-unused - newest first, so support can
// answer "what happened to this landlord's discount" without digging
// through the database directly.
// ---------------------------------------------------------------------
function statusForDiscountRow(row) {
  if (row.consumed_at) return 'consumed';
  if (row.revoked_at) return 'revoked';
  if (row.is_active) return 'active';
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'inactive';
}

async function listDiscountHistory(landlordId) {
  let query = supabase
    .from('landlord_loyalty_discounts')
    .select('*, landlords(full_name, email, phone)')
    .order('granted_at', { ascending: false });
  if (landlordId) query = query.eq('landlord_id', landlordId);

  const { data, error } = await query;
  if (error) throw error;

  const nowIso = new Date().toISOString();
  return (data || []).map((row) => {
    // Whichever of the three consumed_by_* columns is set tells us
    // which payment flow (STK renewal, manual-confirmed renewal, or a
    // property purchase/renewal) actually used this discount - see
    // consumeLoyaltyDiscount's three optional params.
    let consumedByType = null;
    let consumedByPaymentId = null;
    if (row.consumed_by_subscription_payment_id) {
      consumedByType = 'subscription_payment';
      consumedByPaymentId = row.consumed_by_subscription_payment_id;
    } else if (row.consumed_by_manual_payment_id) {
      consumedByType = 'manual_payment';
      consumedByPaymentId = row.consumed_by_manual_payment_id;
    } else if (row.consumed_by_property_payment_id) {
      consumedByType = 'property_payment';
      consumedByPaymentId = row.consumed_by_property_payment_id;
    }

    // Reminder-snooze visibility ("did they even see it") - only ever
    // known for a currently-open (not yet consumed/revoked) grant,
    // since snoozing only applies to a discount still waiting to be
    // used. Reports the single most recent snooze state stored on the
    // row - not a running count, since that isn't tracked separately.
    const currentlySnoozed = !!(row.reminder_snoozed_until && row.reminder_snoozed_until > nowIso);

    return {
      id: row.id,
      landlordId: row.landlord_id,
      landlord: row.landlords || null,
      discountPercentage: Number(row.discount_percentage),
      consecutiveMonthsAtGrant: row.consecutive_months_at_grant,
      status: statusForDiscountRow(row),
      grantedAt: row.granted_at,
      grantedByAdminId: row.granted_by_admin_id,
      note: row.note,
      batchId: row.batch_id,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      consumedByType,
      consumedByPaymentId,
      revokedAt: row.revoked_at,
      revokedByAdminId: row.revoked_by_admin_id,
      reminderSnoozedUntil: row.reminder_snoozed_until,
      currentlySnoozed,
    };
  });
}

// ---------------------------------------------------------------------
// P2 SWEEP (direct request: "after a landlord renews subscription
// with the discount... it should expire unless given another one" -
// the flip side of that is a discount that's never used at all should
// also stop being active once its expiry passes, not just be
// treated-as-inactive by the reads above forever). Run periodically
// by loyaltyDiscountExpiry.job.js. Deliberately does NOT touch
// consumed_at / consumed_by_* - those columns mean "used", expiry
// means "lapsed unused", and the two states stay distinguishable for
// the admin history/audit view.
// ---------------------------------------------------------------------
async function expireLapsedLoyaltyDiscounts() {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('landlord_loyalty_discounts')
    .update({ is_active: false })
    .eq('is_active', true)
    .lt('expires_at', nowIso)
    .not('expires_at', 'is', null)
    .select('id, landlord_id');
  if (error) {
    logger.error('[landlordLoyalty] failed to sweep expired discounts:', error.message);
    return [];
  }
  return data || [];
}

module.exports = {
  computeConsecutiveMonths,
  findConsecutiveLandlordCandidates,
  bulkGrantLoyaltyDiscount,
  revokeLoyaltyDiscount,
  getActiveDiscountForLandlord,
  getActiveDiscountRecordForLandlord,
  consumeLoyaltyDiscount,
  getReminderForLandlord,
  snoozeReminder,
  listActiveDiscounts,
  listDiscountHistory,
  expireLapsedLoyaltyDiscounts,
  DEFAULT_MIN_CONSECUTIVE_MONTHS,
  DEFAULT_DISCOUNT_EXPIRY_DAYS,
};
