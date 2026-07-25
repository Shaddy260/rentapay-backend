// src/services/webpush.service.js
//
// "Live push" - the urgent tier. Fires a real browser/OS push
// notification (via the Web Push protocol + VAPID) for the three
// event types the tenant/landlord/manager needs to see even when the
// portal tab isn't open: payment-confirmation requests, vacate
// notices, and tenant messages. Everything else (rent reminders,
// announcements, generic account updates) only ever updates the
// in-app inbox quietly - callers simply never mark those as urgent,
// so this file is never invoked for them.
//
// Never throws - exactly like sms.service.js/notify.service.js, a
// push delivery hiccup (no subscription yet, browser permission
// denied, an expired subscription) must never block the action that
// triggered it (submitting a payment, sending a chat message, etc.).

const webpush = require('web-push');
const supabase = require('../config/supabase');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@rentapay.co.ke';

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
} else {
  // Fails open - the rest of the app (including notify()) must keep
  // working with push simply disabled if VAPID keys aren't set yet
  // (e.g. a fresh dev environment before `npx web-push generate-vapid-keys`).
  console.warn('[webpush] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set - live push notifications are disabled.');
}

function getPublicKey() {
  return VAPID_PUBLIC_KEY || null;
}

// A hung TCP/TLS handshake to a push service (FCM, Mozilla autopush,
// etc.) has no built-in timeout in the `web-push` library, so a slow
// or unreachable push endpoint can otherwise stall the calling
// request forever. This caps any single send attempt at 8s - past
// that we treat it as failed and move on, the same as any other
// delivery failure.
const SEND_TIMEOUT_MS = 8000;
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Saves (or refreshes) a browser's push subscription for a logged-in
 * user. Called from POST /api/push/subscribe once the frontend has
 * registered its service worker and the person has granted the
 * notification permission.
 */
async function saveSubscription(recipientType, recipientId, subscription) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('Invalid push subscription payload.');
  }

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      recipient_type: recipientType,
      recipient_id: recipientId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
    { onConflict: 'endpoint' }
  );
  if (error) throw error;
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

// FIX (direct request: "notifications... should not land in silently
// unnoticed... default according to the user profiles - if its vibrate
// they vibrate if ring they ring"): looks up which table holds this
// recipient's notification_style. Real, documented limitation: the Web
// Notification API can request vibration or silence, but can't choose
// a custom ringtone - 'ring' below means "let the OS play its normal
// notification sound", the same as any other app on the device.
const STYLE_TABLE = { landlord: 'landlords', tenant: 'tenants', manager: 'property_managers' };
const VIBRATE_PATTERN = [250, 100, 250];

async function getNotificationStyle(recipientType, recipientId) {
  const table = STYLE_TABLE[recipientType];
  if (!table) return 'ring'; // scout/admin: no preference column, use the OS default
  const { data } = await supabase.from(table).select('notification_style').eq('id', recipientId).maybeSingle();
  return data?.notification_style || 'ring';
}

/**
 * Sends a push notification to every browser/device this recipient
 * has subscribed on. Prunes subscriptions the push service reports as
 * gone (410 Gone / 404 Not Found - e.g. the user cleared site data or
 * uninstalled). Never throws.
 *
 * @param {'landlord'|'manager'|'tenant'|'scout'} recipientType
 * @param {string} recipientId
 * @param {{title: string, body: string, url?: string}} payload
 */
async function sendPushToRecipient(recipientType, recipientId, payload) {
  if (!configured) return;

  try {
    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('recipient_type', recipientType)
      .eq('recipient_id', recipientId);
    if (error) throw error;
    if (!subs || subs.length === 0) return;

    const style = await getNotificationStyle(recipientType, recipientId);
    const body = JSON.stringify({
      title: payload.title || 'RentaPay',
      body: payload.body || '',
      url: payload.url || '/',
      // sw.js's showNotification() reads these straight off the
      // payload - silent notifications skip both sound AND vibration
      // (the two aren't independent on most devices), 'vibrate' asks
      // for vibration only (works even with the phone muted), and
      // 'ring' leaves both unset so the OS's own default notification
      // sound/vibration behavior applies, same as any other app.
      silent: style === 'silent',
      vibrate: style === 'vibrate' ? VIBRATE_PATTERN : undefined,
    });

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await withTimeout(
            webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              body
            ),
            SEND_TIMEOUT_MS
          );
        } catch (sendErr) {
          if (sendErr.statusCode === 404 || sendErr.statusCode === 410) {
            await removeSubscription(sub.endpoint);
          } else {
            console.error(`[webpush] send failed for ${recipientType} ${recipientId}:`, sendErr.message);
          }
        }
      })
    );
  } catch (err) {
    console.error(`[webpush] sendPushToRecipient error for ${recipientType} ${recipientId}:`, err.message);
  }
}

module.exports = { getPublicKey, saveSubscription, removeSubscription, sendPushToRecipient };
