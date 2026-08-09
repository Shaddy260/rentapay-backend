// src/controllers/dev.controller.js
//
// DEVELOPMENT-ONLY endpoints. None of this exists in any blueprint
// section - it exists purely to unblock local testing when
// MOCK_DARAJA=true (see services/daraja.service.js), since in that
// mode no real Safaricom callback ever arrives to complete a payment.
//
// This simulates that callback by building the exact JSON shape
// Safaricom sends and routing it through the REAL handleSTKCallback()
// handler - same code path the production callback uses, so there's
// no separate "fake completion" logic to drift out of sync.
//
// Every export here is wired up in server.js ONLY when
// NODE_ENV !== 'production', so this can never be reachable in prod
// even if the routes file is accidentally left mounted.

const { handleSTKCallback } = require('./payment.controller');
const { runMonthlyBilling } = require('../jobs/monthlyBilling.job');

/**
 * POST /api/dev/simulate-payment-success
 * Body: { checkoutRequestId: string, amount?: number, phone?: string }
 *
 * Builds a synthetic "successful" Daraja callback and feeds it through
 * the real handler. Works for BOTH rent payments and landlord
 * subscription payments - handleSTKCallback() already looks up which
 * table the checkoutRequestId belongs to.
 */
async function simulatePaymentSuccess(req, res) {
  const { checkoutRequestId, amount = 1, phone = '254700000000' } = req.body;

  if (!checkoutRequestId) {
    return res.status(400).json({ error: 'checkoutRequestId is required.' });
  }

  // Shape matches Safaricom's real callback body exactly (the same
  // fields processRentPaymentCallback/processSubscriptionPaymentCallback
  // read via extractMetadataValue in payment.controller.js).
  const fakeCallbackBody = {
    Body: {
      stkCallback: {
        MerchantRequestID: `mock-merchant-${Date.now()}`,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully. (SIMULATED)',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amount },
            { Name: 'MpesaReceiptNumber', Value: `MOCK${Date.now()}` },
            { Name: 'TransactionDate', Value: Number(new Date().toISOString().replace(/\D/g, '').slice(0, 14)) },
            { Name: 'PhoneNumber', Value: phone },
          ],
        },
      },
    },
  };

  // Reuse the real handler by constructing minimal req/res-like objects
  // around the fake body, rather than reimplementing its logic here.
  const fakeReq = { body: fakeCallbackBody };
  let responsePayload = null;
  const fakeRes = {
    status() { return this; },
    json(payload) { responsePayload = payload; return this; },
  };

  await handleSTKCallback(fakeReq, fakeRes);

  return res.json({
    message: 'Simulated payment success processed through the real callback handler.',
    checkoutRequestId,
    callbackHandlerResponse: responsePayload,
  });
}

/**
 * POST /api/dev/run-billing
 * Runs the monthly billing job immediately, instead of waiting for the
 * 00:01 cron. Only bills tenants whose due day has actually arrived
 * and who haven't been billed this period yet - doesn't force-bill
 * everyone, so it's safe to call repeatedly while testing. Interest
 * accrual has been removed (no late-payment interest anymore).
 */
async function runBillingNow(req, res) {
  await runMonthlyBilling();
  return res.json({ message: 'Monthly billing run complete.' });
}

module.exports = { simulatePaymentSuccess, runBillingNow };
