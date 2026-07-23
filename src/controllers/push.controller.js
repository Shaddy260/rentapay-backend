// src/controllers/push.controller.js
//
// The subscribe/unsubscribe side of "Live push" - lets a logged-in
// landlord, manager, or tenant register their browser for real Web
// Push notifications. Uses the same recipientFor() shape as
// notifications.controller.js (managers push to the landlord's
// recipient bucket, same "shared access" convention used everywhere
// else in this codebase).

const { effectiveLandlordId } = require('../middleware/auth.middleware');
const { getPublicKey, saveSubscription, removeSubscription } = require('../services/webpush.service');

function recipientFor(req) {
  if (req.user.role === 'tenant') return { type: 'tenant', id: req.user.id };
  if (req.user.role === 'manager') return { type: 'landlord', id: effectiveLandlordId(req) };
  if (req.user.role === 'scout') return { type: 'scout', id: req.user.id };
  if (req.user.role === 'admin') return { type: 'admin', id: 'super-admin' };
  return { type: 'landlord', id: req.user.id };
}

function getVapidPublicKey(req, res) {
  const publicKey = getPublicKey();
  if (!publicKey) return res.status(503).json({ error: 'Push notifications are not configured on this server.' });
  return res.json({ publicKey });
}

async function subscribe(req, res) {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'subscription is required.' });

    const { type, id } = recipientFor(req);
    await saveSubscription(type, id, subscription);
    return res.status(201).json({ message: 'Subscribed to push notifications.' });
  } catch (err) {
    console.error('[push] subscribe error:', err.message);
    return res.status(500).json({ error: 'Failed to save push subscription.' });
  }
}

async function unsubscribe(req, res) {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required.' });

    await removeSubscription(endpoint);
    return res.json({ message: 'Unsubscribed.' });
  } catch (err) {
    console.error('[push] unsubscribe error:', err.message);
    return res.status(500).json({ error: 'Failed to remove push subscription.' });
  }
}

module.exports = { getVapidPublicKey, subscribe, unsubscribe };
