// src/services/vacancyAlertPush.service.js
//
// DIRECT REQUEST: "browser popups to random users... to receive
// browser notifications when a unit goes vacant around them, or just
// when a unit goes vacant". This is the sending half - the opt-in
// flow that collects the subscription lives in public.controller.js /
// vacancy_alert_subscriptions (see 2026-07-vacancy-alert-subscriptions.sql,
// already run). This file mirrors webpush.service.js's shape (same
// "never throws, delivery failures are non-blocking" philosophy) but
// targets that public table instead of push_subscriptions, since
// these subscribers have no landlord/manager/tenant account at all.
//
// Two subscription shapes, matched here:
//   - county IS NULL   -> notify for every vacancy, anywhere
//   - county IS SET     -> notify only when the vacancy's county matches
//     (case-insensitive - free text typed/selected on the public page)

const webpush = require('web-push');
const supabase = require('../config/supabase');
const { getPublicKey } = require('./webpush.service'); // reuses the same VAPID keypair/config check
const { captureException } = require('./sentry.service');
const logger = require('../utils/logger');

const SEND_TIMEOUT_MS = 8000;
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function removeVacancyAlertSubscription(endpoint) {
  if (!endpoint) return;
  await supabase.from('vacancy_alert_subscriptions').delete().eq('endpoint', endpoint);
}

/**
 * Saves (or refreshes) an anonymous browser's vacancy-alert
 * subscription. No recipient identity at all - just the push
 * endpoint/keys plus an optional county filter.
 */
async function saveVacancyAlertSubscription(subscription, county) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('Invalid push subscription payload.');
  }
  const normalizedCounty = county && String(county).trim() ? String(county).trim() : null;

  const { error } = await supabase.from('vacancy_alert_subscriptions').upsert(
    {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      county: normalizedCounty,
    },
    { onConflict: 'endpoint' }
  );
  if (error) throw error;
}

/**
 * Fires a "new vacancy" push to every anonymous subscriber whose
 * filter matches - global (county IS NULL) subscribers always get it,
 * county-scoped subscribers only get it when it matches this unit's
 * county. Called from unit.controller.js the moment a unit becomes
 * vacant AND is publicly listed - never blocks that request (fire and
 * forget from the caller's side; this itself never throws).
 *
 * @param {{unitName: string, unitId: string, county: string|null}} unit
 */
async function notifyVacancyAlertSubscribers(unit) {
  if (!getPublicKey()) return; // VAPID not configured - same fail-open as webpush.service.js

  try {
    const county = unit.county || null;

    // Pull every global subscriber plus (if we know the county)
    // every subscriber scoped to that county. Two queries instead of
    // an OR-with-null-check, since Postgres/PostgREST's `.or()` with
    // `is.null` alongside an `ilike` on the same column is awkward to
    // express reliably through supabase-js.
    const queries = [
      supabase.from('vacancy_alert_subscriptions').select('*').is('county', null),
    ];
    if (county) {
      queries.push(supabase.from('vacancy_alert_subscriptions').select('*').ilike('county', county));
    }
    const results = await Promise.all(queries);
    for (const r of results) if (r.error) throw r.error;

    const seen = new Set();
    const subs = [];
    for (const r of results) {
      for (const sub of r.data || []) {
        if (seen.has(sub.endpoint)) continue;
        seen.add(sub.endpoint);
        subs.push(sub);
      }
    }
    if (subs.length === 0) return;

    const payload = JSON.stringify({
      title: 'A new vacancy just opened up' + (county ? ` in ${county}` : ''),
      body: `Unit "${unit.unitName}" just went vacant${county ? ` in ${county}` : ''}. Check it out on RentaPay.`,
      url: unit.unitId ? `/find-a-house?unit=${unit.unitId}` : '/find-a-house',
    });

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await withTimeout(
            webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload),
            SEND_TIMEOUT_MS
          );
          await supabase
            .from('vacancy_alert_subscriptions')
            .update({ last_notified_at: new Date().toISOString() })
            .eq('endpoint', sub.endpoint);
        } catch (sendErr) {
          if (sendErr.statusCode === 404 || sendErr.statusCode === 410) {
            await removeVacancyAlertSubscription(sub.endpoint);
          } else {
            logger.error('[vacancyAlertPush] send failed:', sendErr.message);
            captureException(sendErr);
          }
        }
      })
    );
  } catch (err) {
    logger.error('[vacancyAlertPush] notifyVacancyAlertSubscribers error:', err.message);
    captureException(err);
  }
}

module.exports = { saveVacancyAlertSubscription, removeVacancyAlertSubscription, notifyVacancyAlertSubscribers };
