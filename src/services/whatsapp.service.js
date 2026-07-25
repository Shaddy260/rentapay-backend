// src/services/whatsapp.service.js
//
// WHATSAPP IS DISABLED (temporarily) - see below.
//
// This used to drive a real Chrome tab via Puppeteer (whatsapp-web.js +
// LocalAuth, authenticated by scanning a QR code with a phone). That
// Chromium instance was launching on every server start and sitting in
// memory the whole time, which is what was maxing out RAM on the
// container/host and generating a constant stream of QR codes in the
// logs. Not needed right now, so it's fully disabled here rather than
// left running in the background.
//
// The functions below keep the EXACT same names/signatures that
// sms.service.js, tenant.controller.js, etc. already import, so nothing
// else in the codebase needs to change. They just no-op (log + resolve
// harmlessly) instead of touching whatsapp-web.js/Puppeteer at all - no
// Chromium process is spawned, so no extra RAM is used and no QR code
// is ever generated.
//
// To re-enable real WhatsApp sending later: restore this file from git
// history (the version that used require('whatsapp-web.js') and called
// client.initialize()), and add whatsapp-web.js + qrcode-terminal back
// to package.json's dependencies.
// ---------------------------------------------------------------------

async function sendWhatsAppMessage(phoneNumber, message) {
  console.log(`[whatsapp] (disabled) would have sent to ${phoneNumber}: ${message}`);
  throw new Error('WhatsApp sending is currently disabled.');
}

async function sendWhatsAppSafe(phoneNumber, message) {
  console.log(`[whatsapp] (disabled) would have sent to ${phoneNumber}: ${message}`);
  return { skipped: true, sent: false, error: 'WhatsApp sending is currently disabled.' };
}

async function sendBulkWhatsAppMessage(phoneNumbers, message) {
  console.log(`[whatsapp] (disabled) would have bulk-sent to ${phoneNumbers.length} numbers: ${message}`);
  return phoneNumbers.map(() => ({
    status: 'fulfilled',
    value: { skipped: true, sent: false, error: 'WhatsApp sending is currently disabled.' },
  }));
}

async function createWhatsAppGroup(groupName, phoneNumbers) {
  throw new Error('WhatsApp group creation is currently disabled.');
}

async function addParticipantsToWhatsAppGroup(groupId, phoneNumbers) {
  throw new Error('WhatsApp group management is currently disabled.');
}

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppSafe,
  sendBulkWhatsAppMessage,
  createWhatsAppGroup,
  addParticipantsToWhatsAppGroup,
};
