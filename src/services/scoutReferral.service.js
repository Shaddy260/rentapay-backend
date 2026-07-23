// src/services/scoutReferral.service.js
//
// Scout Referral Tracking & Notifications feature. Single source of
// truth for the referral pipeline lives in the scout_referrals table
// (see sql/add-scout-referrals.sql). This file centralizes the three
// moments that table gets touched/read from outside scout.controller's
// own CRUD-ish endpoints:
//   1) creditPlacementIfEligible - called from every call site that
//      flips a unit's status to 'occupied', across unit.controller.js
//      and tenant.controller.js.
//   2) getActiveReferralForUnit - used to render the landlord-side
//      "Scout referral" badge and the scout-side vacancy freshness/
//      referral-status view.
//   3) getNotificationRecipients - the "landlord's phone, and if
//      present on that unit/property, manager and caretaker phones"
//      lookup from the spec, shared by the referral-created SMS/push
//      and (if ever needed elsewhere) anything else that wants to
//      reach "everyone actually running this unit day-to-day."

const supabase = require('../config/supabase');
const { notify } = require('./notify.service');

// Proposed in the spec, confirmed by the person building this: a
// referral only counts as the reason a unit got rented if the unit
// flips to occupied within this many days of the scout sharing it.
// Older shares are treated as stale/unrelated and never auto-credited.
const PLACEMENT_CREDIT_WINDOW_DAYS = 15;

// Skip re-notifying the landlord/manager/caretaker by SMS if this
// scout already referred this exact unit within the last X hours -
// avoids spamming them with duplicate texts for the same lead.
const RENOTIFY_COOLDOWN_HOURS = 24;

// ---------------------------------------------------------------------
// Recipients for a unit: landlord's phone/id always; manager + caretaker
// phones/ids only if this unit's property actually has them assigned.
// Mirrors the contact-resolution getVacancies already does for a
// scout's OWN view of a unit, but returns every distinct recipient
// (not just "one best contact") since the spec wants the landlord AND
// manager AND caretaker notified, not just whichever one a scout would
// see as the single listed contact.
// ---------------------------------------------------------------------
async function getNotificationRecipients(unit) {
  const recipients = [];

  const { data: landlord } = await supabase
    .from('landlords')
    .select('id, phone')
    .eq('id', unit.landlord_id)
    .maybeSingle();
  if (landlord?.phone) recipients.push({ type: 'landlord', id: landlord.id, phone: landlord.phone });

  if (unit.property_id) {
    const [{ data: property }, { data: assignments }] = await Promise.all([
      supabase.from('properties').select('caretaker_phone').eq('id', unit.property_id).maybeSingle(),
      supabase
        .from('property_manager_assignments')
        .select('property_managers(id, phone, role_level)')
        .eq('property_id', unit.property_id),
    ]);

    // Static caretaker contact a landlord typed in during property
    // setup (property.controller.js) - separate from a live
    // property_managers login, which is why it's checked in addition
    // to, not instead of, the assignments below.
    if (property?.caretaker_phone) {
      recipients.push({ type: 'caretaker', id: null, phone: property.caretaker_phone });
    }

    for (const a of assignments || []) {
      const m = a.property_managers;
      if (m?.phone) recipients.push({ type: 'manager', id: m.id, phone: m.phone });
    }
  }

  // Skip any blank/duplicate phones - "no blank sends" per the spec.
  const seenPhones = new Set();
  return recipients.filter((r) => {
    if (!r.phone || seenPhones.has(r.phone)) return false;
    seenPhones.add(r.phone);
    return true;
  });
}

// ---------------------------------------------------------------------
// Called right after a scout_referrals row is inserted with
// status: 'shared'. Notifies every actual recipient for the unit by
// SMS + in-app inbox (+ live push, since a scout actively bringing a
// tenant is exactly the kind of urgent, time-sensitive event push
// exists for - same tier as a payment-confirmation request or a
// vacate notice). Never throws - a notification hiccup must never
// undo the referral that was already saved.
// ---------------------------------------------------------------------
async function notifyReferralCreated({ unit, scoutName, unitName }) {
  try {
    const recipients = await getNotificationRecipients(unit);
    const message = `Scout ${scoutName} shared Unit ${unitName} with a prospective tenant. Check it out on RentaPay.`;

    await Promise.allSettled(
      recipients.map((r) =>
        notify(r.type, r.id || unit.landlord_id, r.phone, message, {
          title: 'Scout referral',
          category: 'general',
          urgent: true,
          propertyId: unit.property_id || null,
        })
      )
    );
  } catch (err) {
    console.error('[scoutReferral] notifyReferralCreated error:', err.message);
  }
}

// ---------------------------------------------------------------------
// Rate-limit check: has this scout already referred this exact unit
// within the cooldown window? Used to skip re-notifying (but the spec
// only asks to skip the NOTIFICATION, not the referral log itself -
// see referUnit in scout.controller.js for how this is used).
// ---------------------------------------------------------------------
async function hasRecentReferral(scoutId, unitId) {
  const cutoff = new Date(Date.now() - RENOTIFY_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('scout_referrals')
    .select('id')
    .eq('scout_id', scoutId)
    .eq('unit_id', unitId)
    .gt('shared_at', cutoff)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// ---------------------------------------------------------------------
// The active (non-expired, non-placed) referral for a unit, if any -
// used for the landlord-side "Scout referral" badge. "Active" here
// means shared within the placement-credit window and not yet placed;
// a referral that's aged out of the credit window is functionally
// expired even though nothing has gone back and written status =
// 'expired' onto the row (see the schema comment for why).
// ---------------------------------------------------------------------
async function getActiveReferralForUnit(unitId) {
  const cutoff = new Date(Date.now() - PLACEMENT_CREDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('scout_referrals')
    .select('id, scout_id, status, shared_at, viewed_at, scouts(full_name)')
    .eq('unit_id', unitId)
    .in('status', ['shared', 'viewed_by_landlord'])
    .gt('shared_at', cutoff)
    .order('shared_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    referralId: data.id,
    scoutId: data.scout_id,
    scoutName: data.scouts?.full_name || null,
    status: data.status,
    sharedAt: data.shared_at,
    viewedAt: data.viewed_at,
  };
}

// Bulk version of the above, for listUnits (avoids one query per unit).
async function getActiveReferralsForUnits(unitIds) {
  if (!unitIds || unitIds.length === 0) return {};
  const cutoff = new Date(Date.now() - PLACEMENT_CREDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('scout_referrals')
    .select('id, unit_id, scout_id, status, shared_at, viewed_at, scouts(full_name)')
    .in('unit_id', unitIds)
    .in('status', ['shared', 'viewed_by_landlord'])
    .gt('shared_at', cutoff)
    .order('shared_at', { ascending: false });
  if (error) throw error;

  const byUnit = {};
  for (const row of data || []) {
    // Already ordered newest-first, so the first row seen per unit_id wins.
    if (byUnit[row.unit_id]) continue;
    byUnit[row.unit_id] = {
      referralId: row.id,
      scoutId: row.scout_id,
      scoutName: row.scouts?.full_name || null,
      status: row.status,
      sharedAt: row.shared_at,
      viewedAt: row.viewed_at,
    };
  }
  return byUnit;
}

// ---------------------------------------------------------------------
// Marks the single most recent active referral for a unit as viewed -
// called from the small UI hook on the landlord/manager/caretaker side
// the first time the "Scout referral" badge is actually shown to them
// (see PATCH /scout/referrals/:id/mark-viewed). Idempotent: viewing an
// already-viewed or already-placed referral is a no-op, not an error.
// ---------------------------------------------------------------------
async function markReferralViewed(referralId) {
  const { data: referral, error: fetchErr } = await supabase
    .from('scout_referrals')
    .select('id, status')
    .eq('id', referralId)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!referral || referral.status !== 'shared') return; // nothing to do

  const { error } = await supabase
    .from('scout_referrals')
    .update({ status: 'viewed_by_landlord', viewed_at: new Date().toISOString() })
    .eq('id', referralId);
  if (error) throw error;
}

// ---------------------------------------------------------------------
// Auto-credit: called wherever a unit's status flips to 'occupied'.
// If there's a scout_referrals row for that unit, shared within the
// last PLACEMENT_CREDIT_WINDOW_DAYS, that isn't already 'placed',
// credit it now. Deliberately automatic (no landlord confirmation
// step) per the spec, to keep this low-friction and avoid disputes.
// Never throws - this must never block a tenant being moved in.
// ---------------------------------------------------------------------
async function creditPlacementIfEligible(unitId) {
  try {
    const cutoff = new Date(Date.now() - PLACEMENT_CREDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: referral, error } = await supabase
      .from('scout_referrals')
      .select('id')
      .eq('unit_id', unitId)
      .neq('status', 'placed')
      .gt('shared_at', cutoff)
      .order('shared_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!referral) return;

    await supabase
      .from('scout_referrals')
      .update({ status: 'placed', placed_at: new Date().toISOString() })
      .eq('id', referral.id);
  } catch (err) {
    console.error('[scoutReferral] creditPlacementIfEligible error:', err.message);
  }
}

module.exports = {
  PLACEMENT_CREDIT_WINDOW_DAYS,
  RENOTIFY_COOLDOWN_HOURS,
  getNotificationRecipients,
  notifyReferralCreated,
  hasRecentReferral,
  getActiveReferralForUnit,
  getActiveReferralsForUnits,
  markReferralViewed,
  creditPlacementIfEligible,
};
