// src/controllers/__tests__/payment.controller.callback.test.js
//
// handleSTKCallback is the single place every M-Pesa payment (rent,
// landlord subscriptions, and paid "add a property" requests) lands
// on its way into the ledger. Safaricom RETRIES undelivered callbacks,
// and the app's own self-heal poll (checkRentPaymentStatus /
// checkSubscriptionPaymentStatus) can race the real webhook - so the
// two properties tested most heavily here are exactly the ones a
// silent regression would hit hardest: (1) it always answers
// Safaricom with 200 so we never trigger a retry storm, and (2) it
// never re-applies a payment that's already marked 'completed'
// (double-crediting a tenant's balance or double-activating a
// landlord).

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/daraja.service', () => ({
  initiateSTKPush: jest.fn(),
  querySTKPushStatus: jest.fn(),
}));
jest.mock('../../services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
  wrapEmailHtml: jest.fn((html) => html),
}));
jest.mock('../../services/notify.service', () => ({ notify: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/activityLog.service', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/sentry.service', () => ({ captureException: jest.fn() }));
jest.mock('../../services/tenantRatingReminder.service', () => ({ queuePaymentReminder: jest.fn() }));
jest.mock('../auth.controller', () => ({ activateLandlordAfterPayment: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../property.controller', () => ({ processPropertyPaymentCallback: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/unitLimitEnforcement', () => ({ applyUnitLimitChange: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../middleware/auth.middleware', () => ({ effectiveLandlordId: jest.fn((req) => req.user?.id) }));

const supabase = require('../../config/supabase');
const { notify } = require('../../services/notify.service');
const { setupSupabaseMock } = require('../../test-utils/supabaseMock');
const { handleSTKCallback } = require('../payment.controller');

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function stkBody({ checkoutRequestId = 'CHK1', resultCode = 0, metadata = [] } = {}) {
  return {
    body: {
      Body: {
        stkCallback: {
          CheckoutRequestID: checkoutRequestId,
          ResultCode: resultCode,
          CallbackMetadata: metadata.length ? { Item: metadata } : undefined,
        },
      },
    },
  };
}

const NOT_FOUND = { data: null, error: null };

describe('handleSTKCallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('always responds 200 even when the body has no stkCallback (never trigger a Safaricom retry)', async () => {
    const res = mockRes();
    await handleSTKCallback({ body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('responds 200 for a CheckoutRequestID that matches no payment of any kind', async () => {
    setupSupabaseMock(supabase, {
      payments: NOT_FOUND,
      subscription_payments: NOT_FOUND,
      property_payments: NOT_FOUND,
    });
    const res = mockRes();
    await handleSTKCallback(stkBody({ checkoutRequestId: 'UNKNOWN' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ResultCode: 0 }));
  });

  test('IDEMPOTENCY: a rent payment already marked completed is not re-applied to the tenant balance', async () => {
    const builders = setupSupabaseMock(supabase, {
      payments: {
        data: { id: 'P1', status: 'completed', tenant_id: 'T1', tenants: {}, units: {} },
        error: null,
      },
    });
    const res = mockRes();
    await handleSTKCallback(stkBody({ checkoutRequestId: 'CHK1' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ResultDesc: 'Already processed' }));
    // The guard must return BEFORE touching the row again - no second
    // write, no balance-affecting update.
    expect(builders.payments.update).not.toHaveBeenCalled();
  });

  test('IDEMPOTENCY: an already-completed subscription payment is not re-applied (no double account activation)', async () => {
    const builders = setupSupabaseMock(supabase, {
      payments: NOT_FOUND,
      subscription_payments: { data: { id: 'S1', status: 'completed', landlords: {} }, error: null },
    });
    const res = mockRes();
    await handleSTKCallback(stkBody({ checkoutRequestId: 'CHK2' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ResultDesc: 'Already processed' }));
    expect(builders.subscription_payments.update).not.toHaveBeenCalled();
    const { activateLandlordAfterPayment } = require('../auth.controller');
    expect(activateLandlordAfterPayment).not.toHaveBeenCalled();
  });

  test('a failed STK push (non-zero ResultCode) marks the rent payment failed, not completed', async () => {
    const builders = setupSupabaseMock(supabase, {
      payments: {
        data: { id: 'P1', status: 'pending', tenant_id: 'T1', tenants: { id: 'T1' }, units: {} },
        error: null,
      },
    });
    const res = mockRes();
    await handleSTKCallback(stkBody({ checkoutRequestId: 'CHK1', resultCode: 1032 }), res);

    expect(builders.payments.update).toHaveBeenCalledWith({ status: 'failed' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('a successful rent payment is marked completed and credited to the tenant balance exactly once', async () => {
    const payment = {
      id: 'P1',
      status: 'pending',
      landlord_id: 'L1',
      amount: 5000,
      tenants: { id: 'T1', full_name: 'Jane Tenant', primary_phone: '254700000000', balance_due: 5000, due_day_of_month: 5 },
      units: { unit_name: 'A1', rent_amount: 5000, property_id: 'PR1', due_day_of_month: 5 },
    };
    const builders = setupSupabaseMock(supabase, {
      payments: { data: payment, error: null },
      tenants: { data: {}, error: null },
      landlords: { data: { phone: '254711111111' }, error: null },
    });
    // The idempotency-guard update (`.neq('status','completed').select('id')`)
    // must report a row actually changed, otherwise the function
    // (correctly) treats it as already handled by another caller. This
    // is set on the "bare await" result only, so it doesn't clobber
    // the .maybeSingle() fetch above, which must keep returning the
    // full payment row (with its nested tenants/units) untouched.
    builders.payments.__setThenResult({ data: [{ id: 'P1' }], error: null });

    const res = mockRes();
    await handleSTKCallback(
      stkBody({
        checkoutRequestId: 'CHK1',
        resultCode: 0,
        metadata: [
          { Name: 'MpesaReceiptNumber', Value: 'MP123XYZ' },
          { Name: 'TransactionDate', Value: 20260731120000 },
          { Name: 'PhoneNumber', Value: 254700000000 },
          { Name: 'Amount', Value: 5000 },
        ],
      }),
      res
    );

    expect(builders.payments.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', mpesa_transaction_id: 'MP123XYZ' })
    );
    expect(builders.tenants.update).toHaveBeenCalledWith(
      expect.objectContaining({ balance_due: 0 }) // 5000 owed - 5000 paid = 0
    );
    expect(notify).toHaveBeenCalledWith(
      'tenant', 'T1', '254700000000', expect.any(String), expect.objectContaining({ title: 'Payment Receipt' })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('routes to the property-payment handler when the CheckoutRequestID matches a property payment, not a rent/subscription one', async () => {
    setupSupabaseMock(supabase, {
      payments: NOT_FOUND,
      subscription_payments: NOT_FOUND,
      property_payments: { data: { id: 'PP1', status: 'pending' }, error: null },
    });
    const res = mockRes();
    await handleSTKCallback(stkBody({ checkoutRequestId: 'CHK3', resultCode: 0 }), res);

    const { processPropertyPaymentCallback } = require('../property.controller');
    expect(processPropertyPaymentCallback).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'PP1' }), 0
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('an internal error still responds 200, so Safaricom does not retry into a broken handler forever', async () => {
    supabase.from.mockImplementation(() => { throw new Error('boom'); });
    const res = mockRes();
    await handleSTKCallback(stkBody({ checkoutRequestId: 'CHK1' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
