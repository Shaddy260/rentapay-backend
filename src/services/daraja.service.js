// src/services/daraja.service.js
//
// Wraps Safaricom's Daraja API: OAuth token, STK Push, and transaction
// status query (used for Paybill verification - blueprint 5.3, 5.4).

const crypto = require('crypto');
const axios = require('axios');

const isProduction = process.env.DARAJA_ENV === 'production';
const BASE_URL = isProduction ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

// SECOND likely cause of the same "no real prompt, but it says
// success/verified" symptom, even with MOCK_DARAJA off: Safaricom's
// SANDBOX only ever sends a real STK prompt to phone numbers you've
// registered as test MSISDNs on the Daraja portal. For any other
// number it still returns ResponseCode 0 ("accepted") - and its
// sandbox query/status endpoint commonly reports a canned success
// shortly after - so from this app's point of view the payment looks
// completed even though nothing ever reached the person's phone. If
// this server is live/public (NODE_ENV=production) but DARAJA_ENV was
// never switched to 'production', every payment on it would silently
// hit the sandbox instead of real M-Pesa - this makes that loud
// instead of silent.
if (process.env.NODE_ENV === 'production' && !isProduction) {
  console.error(
    '[daraja] WARNING: NODE_ENV=production but DARAJA_ENV is NOT "production" - Daraja calls are going to the SANDBOX ' +
      '(https://sandbox.safaricom.co.ke), not real M-Pesa. On sandbox, phones that are not registered as Daraja test numbers ' +
      'never receive a real STK prompt, yet the API still reports success - which looks exactly like "no prompt arrives but the ' +
      'account is verified anyway". Set DARAJA_ENV=production in this server\'s environment once you have real Daraja go-live credentials.'
  );
}

const CONSUMER_KEY = process.env.DARAJA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET;
const SHORTCODE = process.env.DARAJA_SHORTCODE;
const PASSKEY = process.env.DARAJA_PASSKEY;
const CALLBACK_URL = process.env.DARAJA_CALLBACK_URL;

// ---------------------------------------------------------------------
// DEV/TEST BYPASS
// ---------------------------------------------------------------------
// Set MOCK_DARAJA=true in .env to skip the real Safaricom API entirely.
// initiateSTKPush() then returns a fake-but-correctly-shaped response
// immediately, so you can develop/test the registration -> OTP -> setup
// wizard flow without sandbox credentials, network calls, or waiting
// for a phone prompt. NEVER set this in production - payments would
// appear to succeed without any real M-Pesa transaction occurring.
//
// IMPORTANT: with MOCK_DARAJA on, nothing ever calls the real Daraja
// callback URL, so payment.controller.js's handleSTKCallback() never
// fires automatically. You need a separate dev-only route to simulate
// it - see routes/dev.routes.js (added alongside this fix) which lets
// you POST to /api/dev/simulate-payment-success with a checkoutRequestId
// to manually trigger the same completion logic the real callback would.
const MOCK_DARAJA = process.env.MOCK_DARAJA === 'true';

// THE FIX for "submitting payment doesn't send the M-Pesa prompt, it
// just says the account is verified immediately": that is EXACTLY
// what MOCK_DARAJA=true does by design (see the block comment above)
// - it was almost certainly left on in the live/running .env. Before
// this, that misconfiguration failed silently: the server started up
// fine, every "STK push" instantly "succeeded" with no real prompt,
// and the very next status poll (checkSubscriptionPaymentStatus /
// checkRentPaymentStatus, 3s later) saw the mocked success and
// completed activation - so every landlord, scout, and tenant payment
// on a live server would go through with real money never actually
// requested. Now the server refuses to start at all if this is ever
// combined with NODE_ENV=production, so the failure is loud and
// immediate (a crash on deploy) instead of quietly faking payments in
// front of real users.
if (MOCK_DARAJA && process.env.NODE_ENV === 'production') {
  throw new Error(
    'FATAL: MOCK_DARAJA=true is set together with NODE_ENV=production. This would fake every M-Pesa payment on a live server ' +
      '(no real STK prompt sent, but the app reports success/"verified" within seconds). Remove MOCK_DARAJA from the production ' +
      'environment - it is a local-development-only bypass.'
  );
}

if (MOCK_DARAJA) {
  console.warn('[daraja] MOCK_DARAJA=true - all STK pushes are FAKE. Do not use in production.');
}

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Gets an OAuth access token, caching it until just before expiry.
 * Daraja tokens are valid for 1 hour.
 */
async function getAccessToken() {
  if (MOCK_DARAJA) return 'mock-token';

  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    throw new Error(
      'Daraja credentials missing: DARAJA_CONSUMER_KEY/DARAJA_CONSUMER_SECRET are not set in .env. ' +
        'Either fill them in, or set MOCK_DARAJA=true to bypass Daraja entirely during development.'
    );
  }

  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

  let response;
  try {
    response = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (err) {
    // This is almost certainly why you were seeing an opaque 500: axios
    // throws here on ANY network/auth failure (wrong keys, sandbox down,
    // no internet), and that rejection was propagating straight up
    // uncaught. Wrapping it with the real Safaricom error body attached
    // turns "500 Internal Server Error" into something you can actually
    // act on.
    const safaricomError = err.response?.data;
    throw new Error(
      `Daraja getAccessToken failed: ${err.message}. ` +
        (safaricomError ? `Safaricom response: ${JSON.stringify(safaricomError)}` : 'No response body - likely a network/connectivity issue.')
    );
  }

  cachedToken = response.data.access_token;
  // Refresh 60 seconds before actual expiry to be safe
  tokenExpiresAt = Date.now() + (Number(response.data.expires_in) - 60) * 1000;

  return cachedToken;
}

function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function getPassword(timestamp) {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
}

/**
 * Initiates an STK Push to the given phone number (blueprint 5.2).
 * @param {string} phoneNumber - format 2547XXXXXXXX
 * @param {number} amount
 * @param {string} accountReference - e.g. unit payment code, used to identify what's being paid for
 * @param {string} transactionDesc
 */
async function initiateSTKPush({ phoneNumber, amount, accountReference, transactionDesc }) {
  if (MOCK_DARAJA) {
    // Shaped to match Safaricom's real response exactly, so calling
    // code (auth.controller.js, payment.controller.js) needs zero
    // special-casing - it just reads .CheckoutRequestID either way.
    const fakeId = `ws_CO_MOCK_${crypto.randomBytes(6).toString('hex')}`;
    console.log(`[daraja MOCK] Fake STK push -> phone=${phoneNumber} amount=${amount} ref=${accountReference} checkoutRequestId=${fakeId}`);
    return {
      MerchantRequestID: `mock-merchant-${Date.now()}`,
      CheckoutRequestID: fakeId,
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing (MOCKED)',
      CustomerMessage: 'Success. Request accepted for processing (MOCKED)',
    };
  }

  if (!SHORTCODE || !PASSKEY) {
    throw new Error(
      'Daraja credentials missing: DARAJA_SHORTCODE/DARAJA_PASSKEY are not set in .env. ' +
        'Either fill them in, or set MOCK_DARAJA=true to bypass Daraja entirely during development.'
    );
  }
  if (!CALLBACK_URL || !CALLBACK_URL.startsWith('https://')) {
    throw new Error(
      `Daraja callback URL invalid: "${CALLBACK_URL}". It must be a public HTTPS URL (e.g. an ngrok tunnel) - Safaricom rejects http:// and localhost URLs.`
    );
  }

  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const password = getPassword(timestamp);

  try {
    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(amount),
        PartyA: phoneNumber,
        PartyB: SHORTCODE,
        PhoneNumber: phoneNumber,
        CallBackURL: CALLBACK_URL,
        AccountReference: accountReference,
        TransactionDesc: transactionDesc,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    return response.data; // contains CheckoutRequestID, MerchantRequestID
  } catch (err) {
    const safaricomError = err.response?.data;
    throw new Error(
      `Daraja initiateSTKPush failed: ${err.message}. ` +
        (safaricomError
          ? `Safaricom response: ${JSON.stringify(safaricomError)}`
          : 'No response body - likely a network/connectivity issue or invalid CallBackURL.')
    );
  }
}

/**
 * Queries the status of an STK push transaction (useful for polling
 * when the callback hasn't arrived yet).
 */
async function querySTKPushStatus(checkoutRequestId) {
  if (MOCK_DARAJA) {
    return { ResultCode: '0', ResultDesc: 'The service request is processed successfully. (MOCKED)' };
  }

  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const password = getPassword(timestamp);

  try {
    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    return response.data;
  } catch (err) {
    const safaricomError = err.response?.data;
    throw new Error(`Daraja querySTKPushStatus failed: ${err.message}. ${safaricomError ? JSON.stringify(safaricomError) : ''}`);
  }
}

/**
 * Verifies a manually-submitted Paybill transaction ID (blueprint 5.3, 5.4).
 * NOTE: Daraja's standard public API does not expose a direct
 * "verify any transaction ID" endpoint - that requires the C2B
 * reconciliation/Transaction Status API which needs a registered
 * Org Shortcode + initiator credentials. This function is the
 * integration point for that call; wire in TransactionStatus API
 * credentials here once you've registered for them with Safaricom.
 */
async function verifyTransactionId(transactionId) {
  throw new Error(
    'verifyTransactionId: Daraja Transaction Status API credentials not yet configured. ' +
      'Register for the Transaction Status API on the Daraja portal, then implement this call.'
  );
}

module.exports = { getAccessToken, initiateSTKPush, querySTKPushStatus, verifyTransactionId, MOCK_DARAJA };
