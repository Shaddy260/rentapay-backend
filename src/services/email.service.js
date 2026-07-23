// src/services/email.service.js
//
// Wraps Resend's email API (blueprint 10, 16: 3,000 free emails/month).

const axios = require('axios');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'noreply@rentapay.co.ke';

// Single source of truth for the platform's support address (direct
// request: "update the support emails across the platform to
// support@rentapay.co.ke"). Anything that shows/sends a support
// contact address - the help-request admin notification fallback,
// email footers, etc. - should import this instead of hardcoding its
// own string, so there's only ever one place to change it again.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@rentapay.co.ke';

// Small helper so every call site that used to hand a plain-text SMS/
// WhatsApp string to sendSMS() can wrap it into a minimally-styled
// HTML email body without every controller reinventing the same
// couple of lines. Preserves line breaks, and appends a standard
// "need help" footer pointing at the one real support address.
function wrapEmailHtml(message, { footer = true } = {}) {
  const body = String(message).split('\n').map((line) => `<p style="margin:0 0 12px;">${line}</p>`).join('');
  const footerHtml = footer
    ? `<hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0;" />
       <p style="margin:0;color:#666;font-size:13px;">Need help? Contact us at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`
    : '';
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.5;">${body}${footerHtml}</div>`;
}

/**
 * IMPORTANT: this function never throws - see sendSMS in
 * sms.service.js for the full explanation of why. Same reasoning
 * applies here: email is always a side-effect notification after a
 * real operation has already succeeded.
 */
async function sendEmail(to, subject, htmlBody) {
  if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set - skipping email send. Subject would have been:', subject);
    return { skipped: true, sent: false };
  }

  try {
    const response = await axios.post(
      'https://api.resend.com/emails',
      {
        from: RESEND_FROM_EMAIL,
        to: [to],
        subject,
        html: htmlBody,
      },
      {
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return { ...response.data, sent: true };
  } catch (err) {
    console.error('[email] Failed to send email (non-fatal - message was NOT delivered):', err.response?.data || err.message);
    return { error: err.message, sent: false };
  }
}

module.exports = { sendEmail, SUPPORT_EMAIL, wrapEmailHtml };
