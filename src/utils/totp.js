// src/utils/totp.js
//
// TOTP (RFC 6238) two-factor authentication - authenticator-app based
// (Google Authenticator, Authy, 1Password, etc), not email/SMS.
//
// WHY THIS EXISTS (direct request: "avoid emails and simply use 2FA
// to escape email costs"): the old admin OTP (adminLogin/
// adminVerifyOTP in auth.controller.js) stored its code in
// `global.__adminOtpStore` - a plain in-memory variable on ONE Node
// process. Any host running more than one worker/instance (or that
// restarts the process between requests, e.g. a free-tier dyno
// spinning down) can route the login and the verify call to two
// different processes; the second one never saw the OTP get set, so
// it always says "Invalid OTP" even for the exact code that was
// emailed. That's the "first login works, every one after it says
// wrong OTP" bug. TOTP has nothing to lose between requests - the
// secret is in the database, and validity is computed fresh from
// secret + current time on whichever process handles the request - so
// this class of bug can't happen here, and there's no per-login email
// to send at all.
//
// Deliberately dependency-free (no otplib/speakeasy): this is ~80
// lines of RFC 6238 on top of Node's built-in `crypto`, and avoiding
// a new dependency means nothing to `npm install` before this ships.

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30; // standard TOTP time step
const DIGITS = 6;

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder !== 0) {
    const lastChunk = bits.slice(bits.length - remainder).padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(lastChunk, 2)];
  }
  // Pad to a multiple of 8 chars per the base32 spec (authenticator
  // apps are lenient either way, but this keeps it standards-clean).
  while (output.length % 8 !== 0) output += '=';
  return output;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

// Generates a fresh random secret for a new 2FA enrollment.
// 20 bytes (160 bits) is the standard TOTP secret size.
function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer split across two 32-bit
  // writes since Node's writeBigInt64BE needs a BigInt - this keeps
  // it working on any Node version without relying on BigInt support.
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binCode % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Verifies a 6-digit code against a base32 secret. `window` allows a
// small amount of clock drift between the phone and the server - 1
// means the previous and next 30-second steps are also accepted (so
// up to ~30-59s of drift either direction), which matches how every
// major authenticator app itself tolerates drift.
function verifyTotp(secret, token, window = 1) {
  if (!secret || !token) return false;
  const cleanToken = String(token).trim();
  if (!/^\d{6}$/.test(cleanToken)) return false;

  const secretBuffer = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);

  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    if (hotp(secretBuffer, counter + errorWindow) === cleanToken) return true;
  }
  return false;
}

// otpauth:// URI that authenticator apps scan as a QR code.
// `accountLabel` should be something identifying, e.g. the admin's
// email or "RentaPay Admin" - shown under the entry in the app.
function buildOtpAuthUrl(secret, accountLabel, issuer = 'RentaPay') {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// One-time recovery codes shown at enrollment, for when the phone
// with the authenticator app is lost/unavailable. Store only the
// hashes (see hashRecoveryCode) - never the plaintext.
function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // e.g. "7K3F-9QXZ" - short enough to type, long enough to matter.
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}

module.exports = {
  generateTotpSecret,
  verifyTotp,
  buildOtpAuthUrl,
  generateRecoveryCodes,
  hashRecoveryCode,
};
