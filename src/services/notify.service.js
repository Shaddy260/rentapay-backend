// src/services/notify.service.js
//
// THE FIX for "any reminder, bulk message, update, or announcement
// should go to the tenant's phone number AND the portal's inbox" -
// one shared function that every SMS-sending call site should route
// through instead of calling sendSMS directly, so nothing is ever
// sent to a phone but silently missing from the portal (or vice
// versa).

const supabase = require('../config/supabase');
const { sendPushToRecipient } = require('./webpush.service');
const { sendEmail, wrapEmailHtml } = require('./email.service');
const { isSubscriptionExpiredFor } = require('../utils/subscriptionGate');
const logger = require('../utils/logger');

// FIX (direct request: "modify such that all these otps and passwords
// and resets and everything that needs to be sent to be sent via
// email... connect all otps, password resets and all the messages
// that were being sent via whatsapp previously to direct to their
// emails"): WhatsApp sending is permanently disabled (see
// whatsapp.service.js) and sms.service.js was only ever a thin bridge
// to it, so every message routed through here was silently going
// nowhere. notify() now looks up the recipient's own email (the main
// `email` column - never a "backup" one, none exists) and sends
// there instead. The `phone` parameter below is intentionally no
// longer used to send anything - it's kept in the function signature
// purely so none of the ~30 existing call sites across the codebase
// need to change.
const RECIPIENT_EMAIL_LOOKUP = {
  landlord: { table: 'landlords', emailField: 'email' },
  manager: { table: 'property_managers', emailField: 'email' },
  tenant: { table: 'tenants', emailField: 'email' },
  // PHASE 10 - qualification/tier-crossed notifications for a BA go
  // through this same notify() helper (in-app inbox row + push, email
  // off by default like every other non-tenant-reminder call site).
  brand_ambassador: { table: 'brand_ambassadors', emailField: 'email' },
};

async function resolveRecipientEmail(recipientType, recipientId) {
  const lookup = RECIPIENT_EMAIL_LOOKUP[recipientType];
  if (!lookup) return null; // e.g. 'admin' - handled separately via SUPER_ADMIN_EMAIL at the call site
  const { data } = await supabase.from(lookup.table).select(lookup.emailField).eq('id', recipientId).maybeSingle();
  return data?.[lookup.emailField] || null;
}

// Resolves the tenant's own landlord/property so email suppression can
// reuse the same account-vs-per-property expiry resolution the rest of
// the app already relies on (subscriptionGate.js).
async function isTenantOwnerSubscriptionExpired(tenantId, propertyIdHint) {
  let propertyId = propertyIdHint || null;
  const { data: tenant } = await supabase
    .from('tenants')
    .select('landlord_id, units(property_id)')
    .eq('id', tenantId)
    .maybeSingle();
  if (!tenant) return false;
  if (!propertyId) propertyId = tenant.units?.property_id || null;
  const { expired } = await isSubscriptionExpiredFor(tenant.landlord_id, propertyId);
  return expired;
}

/**
 * Sends an SMS AND writes a matching row into the recipient's
 * in-portal notifications inbox. Safe to call even if one side fails
 * (e.g. SMS provider hiccup) - the other still goes through, and the
 * failure is logged rather than thrown, so a notification problem
 * never blocks the action that triggered it (payment, reminder job,
 * etc.).
 *
 * @param {'landlord'|'manager'|'tenant'|'admin'} recipientType
 * @param {string} recipientId - a uuid for every role except 'admin',
 *   which always uses the literal string 'super-admin' (see
 *   auth.controller.js signToken) - recipient_id is a `text` column
 *   specifically to allow that.
 * @param {string} phone - phone number to SMS (already normalized)
 * @param {string} message - SMS body; also used as the inbox body
 * @param {object} [opts]
 * @param {string} [opts.title] - short inbox title (defaults to a generic one per category)
 * @param {string} [opts.category] - 'rent_reminder' | 'overdue' | 'announcement' | 'account' | 'general'
 * @param {string} [opts.propertyId] - direct request: "every apartment
 *   be solely independent... nothing should leak" - tags this
 *   notification with the specific property it's about, so a
 *   landlord's inbox can be filtered down to just the apartment
 *   they're currently viewing. Leave unset for genuinely account-wide
 *   notices (password changes, new manager added, etc.) which should
 *   keep showing up no matter which property is selected.
 * @param {boolean} [opts.urgent] - fires a real browser/OS push
 *   notification via webpush.service, on top of the SMS + in-app inbox
 *   row every notification already gets. Direct request: "yes u need
 *   that even if it'll be asking for notification permission from the
 *   user" - so this now defaults to true for EVERY notification, not
 *   just payment/vacate/message events. Pass `urgent: false`
 *   explicitly for the rare case something should stay inbox-only.
 */
// FIX (direct request: "the things needed to be sent using email
// should be passwords, otps... and for password resets... and rent
// reminders... anything else should be sent in-app updates and the
// browser push notifications"): notify() used to email on EVERY
// notification by default. It now does the opposite - email is OFF
// by default, and a call site must explicitly pass `allowEmail: true`
// to get one. Passwords/OTPs/password-resets never went through this
// function at all (they call sendEmail() directly in
// auth.controller.js) so they're completely unaffected by this
// change.
//
// UPDATE (direct request: "shift them from email to in app
// notifications and push notifications... shifting from email to in
// app notifications means we are going to remind them everyday"):
// rentReminders.job.js and subscriptionReminders.job.js no longer set
// `allowEmail: true` at all - both now rely entirely on this
// function's default in-app inbox + push behaviour, running daily
// instead of a throttled email cadence. No call site currently passes
// `allowEmail: true` through notify() any more; email delivery for
// reminders now only happens via the small number of one-off,
// critical account-status emails (e.g. the actual subscription-expiry
// transition) that call sendEmail() directly alongside notify(), not
// through the allowEmail flag.
async function notify(recipientType, recipientId, phone, message, opts = {}) {
  const category = opts.category || 'general';
  const title = opts.title || defaultTitle(category);
  const urgent = opts.urgent !== false;
  let allowEmail = opts.allowEmail === true;

  // DIRECT REQUEST: "no emails should be sent to his tenants...only
  // in app notification (during this period when account subscription
  // has ended and not renewed yet)". A landlord/property with a
  // lapsed subscription must not have RentaPay emailing on their
  // behalf, even for call sites that normally would (e.g. the
  // automated rent-reminder cron). In-app inbox rows and push still
  // go out as normal - only the email leg is suppressed.
  if (allowEmail && recipientType === 'tenant') {
    try {
      const expired = await isTenantOwnerSubscriptionExpired(recipientId, opts.propertyId);
      if (expired) allowEmail = false;
    } catch (err) {
      // Fail open on a lookup hiccup - don't let a subscription-status
      // check block a real reminder from going out by email.
      logger.error('[notify] subscription-expiry check failed:', err.message);
    }
  }

  // opts.email lets a caller that already has the account row on hand
  // skip the extra lookup query; otherwise resolve it here.
  const email = !allowEmail ? null : (opts.email || (await resolveRecipientEmail(recipientType, recipientId)));

  const tasks = [
    email ? sendEmail(email, title, wrapEmailHtml(message)) : Promise.resolve({ skipped: true, sent: false, intentional: !allowEmail }),
    // FIX: this insert used to be considered "fine" by the caller
    // even when it returned a Supabase error object - .insert() does
    // NOT throw on a DB error, it resolves with { error }. Wrapped so
    // a real error (bad recipientId, RLS block, missing migration,
    // etc.) is actually thrown and shows up as a rejection below
    // instead of silently vanishing while callers assume it worked.
    supabase
      .from('notifications')
      .insert({ recipient_type: recipientType, recipient_id: recipientId, title, body: message, category, property_id: opts.propertyId || null })
      .then(({ error }) => { if (error) throw error; }),
  ];
  if (urgent) {
    tasks.push(sendPushToRecipient(recipientType, recipientId, { title, body: message }));
  }

  const results = await Promise.allSettled(tasks);

  const labels = ['Email', 'inbox', 'push'];
  const status = {};
  results.forEach((r, i) => {
    // sendEmail() never throws (see email.service.js) - it resolves
    // with { sent: false } on failure/skip instead, so a fulfilled
    // promise alone doesn't mean the email actually went out.
    status[labels[i].toLowerCase()] = r.status === 'fulfilled' && (labels[i] !== 'Email' || r.value?.sent === true);
    if (r.status === 'rejected') {
      logger.error(`[notify] ${labels[i]} delivery failed for ${recipientType} ${recipientId}:`, r.reason?.message || r.reason);
    }
  });

  // FIX (direct request: "the message does not reach the tenants or
  // is nowhere to be seen" while the sender's UI claimed success):
  // previously this function never threw, so ANY caller doing
  // Promise.allSettled(items.map(notify)) counted every recipient as
  // a success no matter what actually happened. Now it throws when
  // BOTH the email and the in-portal inbox row failed - the recipient
  // got nothing, anywhere - so callers that use allSettled/try-catch
  // per recipient can report a real, accurate delivered count.
  if (!status.email && !status.inbox) {
    throw new Error(`Delivery failed on all channels for ${recipientType} ${recipientId}`);
  }

  return status;
}

function defaultTitle(category) {
  switch (category) {
    case 'rent_reminder': return 'Rent Reminder';
    case 'overdue': return 'Overdue Notice';
    case 'announcement': return 'Announcement';
    case 'account': return 'Account Update';
    default: return 'Notification';
  }
}

module.exports = { notify };
