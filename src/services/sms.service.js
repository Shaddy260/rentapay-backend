// src/services/sms.service.js
//
// THIS IS NOW A BRIDGE, NOT A REAL SMS SENDER. Africa's Talking has
// been fully removed per product decision - every call site in this
// codebase still calls sendSMS(phone, message) (nothing else changed),
// but under the hood this redirects straight to the local
// whatsapp-web.js session in whatsapp.service.js. Kept as sendSMS/
// sendBulkSMS (same function names, same signatures, same return
// shape) specifically so no controller needed to change.
//
// IMPORTANT: this function still never throws, for the exact same
// reason as before - every caller sends this as a side-effect
// notification AFTER the real operation (registration, login, OTP,
// password change) has already succeeded. A delivery failure here
// (phone offline, WhatsApp session not authenticated, a Puppeteer
// hiccup) must never cause the calling operation to report failure
// when it actually succeeded. sendWhatsAppSafe() in whatsapp.service.js
// already guarantees this never throws; this file is a thin pass-through.

const { sendWhatsAppSafe, sendBulkWhatsAppMessage } = require('./whatsapp.service');

/**
 * Sends a notification to one phone number via the local WhatsApp
 * session. Phone numbers should be in international format e.g.
 * 2547XXXXXXXX. Never throws - see whatsapp.service.js's
 * sendWhatsAppSafe for the crash-proofing this relies on.
 */
async function sendSMS(phoneNumber, message) {
  return sendWhatsAppSafe(phoneNumber, message);
}

/**
 * Sends the same message to multiple numbers (bulk reminders etc.)
 * via WhatsApp. Never throws - failed sends show up as 'rejected' in
 * the settled results, inspect them if you need per-recipient status.
 */
async function sendBulkSMS(phoneNumbers, message) {
  return sendBulkWhatsAppMessage(phoneNumbers, message);
}

module.exports = { sendSMS, sendBulkSMS };
