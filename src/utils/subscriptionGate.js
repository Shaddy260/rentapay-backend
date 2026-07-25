// src/utils/subscriptionGate.js
//
// FIX (direct request: "when a landlord's subscription is expired...
// they should not be able to access the services to that apartment
// whose subscription is expired, but they should be able to navigate
// to their other properties... if their other property's subscription
// is expired also, show them the banner still"): the dashboard
// already computes per-property vs landlord-wide expiry correctly
// (dashboard.controller.js's usesOwnClock/effectiveStatus) for what
// to SHOW - this is the same resolution logic, reusable from any
// controller that needs to actually BLOCK a write action (confirming
// a payment, adding a unit/tenant, sending reminders, etc.) against
// whichever property that action is scoped to, not just the
// currently-active one shown in the header.
//
// A property "uses its own clock" only once it's been given its own
// per-property subscription (unit_limit set on the properties row -
// see add-per-property-subscriptions.sql); otherwise it shares the
// landlord's account-wide subscription_status, exactly like the
// dashboard summary already assumes.

const supabase = require('../config/supabase');

/**
 * @param {string} landlordId
 * @param {string|null} propertyId - the property the action is scoped
 *   to (a unit's property_id, a tenant's unit's property_id, etc).
 *   Pass null for an action with no specific property (falls back to
 *   the landlord's own account-wide status).
 * @returns {Promise<{expired: boolean, scopedToPropertyId: string|null}>}
 */
async function isSubscriptionExpiredFor(landlordId, propertyId) {
  let property = null;
  if (propertyId) {
    const { data } = await supabase
      .from('properties')
      .select('id, unit_limit, subscription_status')
      .eq('id', propertyId)
      .maybeSingle();
    property = data;
  }

  const usesOwnClock = !!(property && property.unit_limit != null);
  if (usesOwnClock) {
    return { expired: property.subscription_status === 'expired', scopedToPropertyId: property.id };
  }

  const { data: landlord } = await supabase
    .from('landlords')
    .select('subscription_status')
    .eq('id', landlordId)
    .maybeSingle();
  return { expired: landlord?.subscription_status === 'expired', scopedToPropertyId: null };
}

/**
 * Convenience wrapper for controllers: checks and, if expired, sends
 * the 403 itself and returns true (so the caller just does
 * `if (await blockIfSubscriptionExpired(...)) return;`). Returns
 * false (nothing sent) when the subscription is fine.
 */
async function blockIfSubscriptionExpired(req, res, landlordId, propertyId) {
  const { expired } = await isSubscriptionExpiredFor(landlordId, propertyId);
  if (expired) {
    res.status(403).json({
      error: 'This apartment\u2019s RentaPay subscription has expired. Renew it to use this feature - your data is safe, and your other apartments (if any) are unaffected.',
      subscriptionExpired: true,
    });
    return true;
  }
  return false;
}

module.exports = { isSubscriptionExpiredFor, blockIfSubscriptionExpired };
