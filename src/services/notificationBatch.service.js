// src/services/notificationBatch.service.js
//
// BUILD SPEC PHASE 20 - Notification Batching & Rate-Limiting.
//
// A lightweight queue-and-flush layer that sits in FRONT of existing
// notification sends (notify.service.js / webpush.service.js) for the
// specific high-frequency streams named in the spec:
//   - BA-facing qualification / tier-crossed alerts (Phase 10)
//   - the admin "ping" for in-app BA reports (Phase 7)
//
// This deliberately does NOT change what triggers a notification, and
// it never touches anything that changes real state (qualification
// writes, payout marks, the BA report's own inbox content) - those
// still happen exactly where they always did, before this layer is
// ever reached. This only governs *when/how the alert itself is
// delivered*.
//
// Behavior, per spec:
//   - A single lone event for a recipient+stream sends immediately,
//     exactly like before batching existed, so the very next
//     qualification for a BA isn't delayed just because a batching
//     layer now exists.
//   - If another event for the same recipient+stream is already
//     queued (hasn't flushed yet) when a new one arrives, both wait
//     for the periodic flush and go out as ONE combined message.
//   - The periodic flush (notificationBatchFlush.job.js) runs every
//     NOTIFICATION_BATCH_WINDOW_MINUTES (default 30) and delivers
//     anything still queued, however many events piled up, so nothing
//     is ever silently dropped even if delivery hiccups along the way.
//
// Best-effort throughout, same posture as notify.service.js and
// webpush.service.js: a queue/flush hiccup here is logged and must
// never bubble up and block the caller's real work.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { captureException } = require('./sentry.service');

const DEFAULT_WINDOW_MINUTES = 30;

function windowMinutes() {
  const n = Number(process.env.NOTIFICATION_BATCH_WINDOW_MINUTES);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 24 * 60) : DEFAULT_WINDOW_MINUTES;
}

/**
 * Queues one event for (recipientType, recipientId, batchKey). If
 * nothing else is currently queued (unflushed) for that same
 * recipient+stream, delivers it immediately via `sendSingle(event)`
 * and marks it flushed right away - so a lone event is never delayed.
 * Otherwise leaves it queued for the next periodic flush to combine
 * with whatever else lands before then.
 *
 * @param {object} event
 * @param {string} event.recipientType - e.g. 'brand_ambassador' | 'admin'
 * @param {string} event.recipientId
 * @param {string} event.batchKey - stream name events combine within, e.g. 'ba_alert'
 * @param {string} event.eventType - e.g. 'qualified' | 'tier_crossed' | 'ba_report'
 * @param {string} [event.fragment] - short human-readable summary of this one event
 * @param {object} [event.metadata]
 * @param {(event: object) => Promise<void>} sendSingle - delivers the lone-event message right now
 * @returns {Promise<{sentImmediately: boolean}>}
 */
async function queueBatchedNotification(event, sendSingle) {
  const { recipientType, recipientId, batchKey, eventType, fragment = null, metadata = {} } = event;
  if (!recipientType || !recipientId || !batchKey || !eventType) {
    throw new Error('queueBatchedNotification requires recipientType, recipientId, batchKey and eventType.');
  }

  const { data: row, error: insertErr } = await supabase
    .from('notification_batch_queue')
    .insert({
      recipient_type: recipientType,
      recipient_id: recipientId,
      batch_key: batchKey,
      event_type: eventType,
      fragment,
      metadata,
    })
    .select('id')
    .single();
  if (insertErr) throw insertErr;

  const { count, error: countErr } = await supabase
    .from('notification_batch_queue')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_type', recipientType)
    .eq('recipient_id', recipientId)
    .eq('batch_key', batchKey)
    .is('flushed_at', null)
    .neq('id', row.id);
  if (countErr) throw countErr;

  if ((count || 0) === 0) {
    // Nothing else queued for this recipient+stream right now - a
    // lone event, so it goes out immediately exactly as it would have
    // before this batching layer existed.
    try {
      await sendSingle(event);
    } finally {
      // Mark flushed even if delivery itself failed - matches every
      // other notification path's best-effort posture (a delivery
      // hiccup is logged by sendSingle's own caller, never retried
      // forever here).
      await supabase.from('notification_batch_queue').update({ flushed_at: new Date().toISOString() }).eq('id', row.id);
    }
    return { sentImmediately: true };
  }

  return { sentImmediately: false };
}

/**
 * Flushes every still-queued event for one batch_key, grouped by
 * recipient, delivering one combined message per recipient via
 * `sendCombined(recipientType, recipientId, events)`. Every row this
 * touches is marked flushed regardless of delivery outcome, so a
 * delivery failure never leaves the same events queued forever.
 *
 * @returns {Promise<{recipients: number, events: number}>}
 */
async function flushBatchedNotifications(batchKey, sendCombined) {
  const { data: rows, error } = await supabase
    .from('notification_batch_queue')
    .select('*')
    .eq('batch_key', batchKey)
    .is('flushed_at', null)
    .order('created_at', { ascending: true })
    .limit(2000);
  if (error) throw error;
  if (!rows || rows.length === 0) return { recipients: 0, events: 0 };

  const byRecipient = new Map();
  for (const r of rows) {
    const key = `${r.recipient_type}:${r.recipient_id}`;
    const list = byRecipient.get(key) || [];
    list.push(r);
    byRecipient.set(key, list);
  }

  let recipients = 0;
  for (const [key, events] of byRecipient.entries()) {
    const [recipientType, recipientId] = key.split(':');
    try {
      await sendCombined(recipientType, recipientId, events);
      recipients += 1;
    } catch (err) {
      logger.error(`[notificationBatch] combined send failed for ${key} (${batchKey}):`, err.message);
      captureException(err);
    } finally {
      const ids = events.map((e) => e.id);
      await supabase.from('notification_batch_queue').update({ flushed_at: new Date().toISOString() }).in('id', ids);
    }
  }

  return { recipients, events: rows.length };
}

module.exports = { queueBatchedNotification, flushBatchedNotifications, windowMinutes };
