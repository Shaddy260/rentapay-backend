// src/controllers/__tests__/auth.controller.login.test.js
//
// login() is the single highest-value place in the codebase for a
// regression test: a silent bug here means real users get locked out
// (or worse, let in when they shouldn't be). These tests isolate
// login() from the database and from every outbound side effect
// (email, JWT signing, activity log, Sentry) so they run in
// milliseconds and only fail when login()'s own decision logic
// changes - not because a mocked collaborator's shape changed.
//
// Run with: npm test (after `npm install` - see package.json).

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/daraja.service', () => ({
  initiateSTKPush: jest.fn(),
  querySTKPushStatus: jest.fn(),
}));
jest.mock('../../services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
  wrapEmailHtml: jest.fn((html) => html),
  SUPPORT_EMAIL: 'support@example.com',
}));
jest.mock('../../services/activityLog.service', () => ({ logActivity: jest.fn() }));
jest.mock('../announcement.controller', () => ({
  postSystemAnnouncement: jest.fn(),
  getActorDisplay: jest.fn(),
}));
jest.mock('../../services/sentry.service', () => ({ captureException: jest.fn() }));
jest.mock('../../utils/password', () => ({
  hashPassword: jest.fn(async (plain) => `hashed:${plain}`),
  // Deliberately simple, deterministic stand-in for bcrypt so tests
  // don't depend on the native bcrypt binding being built - a
  // password "matches" iff the stored hash is `hashed:<that password>`.
  comparePassword: jest.fn(async (plain, hash) => hash === `hashed:${plain}`),
  validatePasswordStrength: jest.fn(() => ({ valid: true })),
}));
jest.mock('../../middleware/auth.middleware', () => ({
  signToken: jest.fn(() => 'fake.jwt.token'),
  effectiveLandlordId: jest.fn((req) => req.user?.landlordId || req.user?.id),
}));

const supabase = require('../../config/supabase');
const { setupSupabaseMock } = require('../../test-utils/supabaseMock');
const { login } = require('../auth.controller');

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

const NOT_FOUND = { data: null, error: null };
const SETTINGS_OPEN = { platform_settings: { data: { is_locked_down: false, lockdown_reason: null }, error: null } };

describe('auth.controller login()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects a request missing email or password', async () => {
    const res = mockRes();
    await login({ body: { email: 'a@b.com' } }, res); // no password
    expect(res.status).toHaveBeenCalledWith(400);

    const res2 = mockRes();
    await login({ body: { password: 'x' } }, res2); // no email
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  test('turns everyone away while the platform is locked down, before touching any account table', async () => {
    setupSupabaseMock(supabase, {
      platform_settings: { data: { is_locked_down: true, lockdown_reason: 'Scheduled maintenance' }, error: null },
      landlords: NOT_FOUND,
      property_managers: NOT_FOUND,
      tenants: NOT_FOUND,
    });
    const res = mockRes();
    await login({ body: { email: 'a@b.com', password: 'x' } }, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ lockedDown: true, error: 'Scheduled maintenance' }));
  });

  test('never reveals whether an email is registered - same message for unknown email', async () => {
    setupSupabaseMock(supabase, {
      ...SETTINGS_OPEN,
      landlords: NOT_FOUND,
      property_managers: NOT_FOUND,
      tenants: NOT_FOUND,
    });
    const res = mockRes();
    await login({ body: { email: 'nobody@nowhere.com', password: 'x' } }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid email or password.' });
  });

  test('a wrong password on a real account: same 401 message, and increments failed_login_attempts', async () => {
    const landlord = {
      id: 'L1', email: 'landlord@x.com', phone: '254711111111',
      password_hash: 'hashed:correct-password',
      failed_login_attempts: 0, locked_until: null,
      is_verified: true, subscription_status: 'active',
    };
    const builders = setupSupabaseMock(supabase, {
      ...SETTINGS_OPEN,
      landlords: { data: landlord, error: null },
      property_managers: NOT_FOUND,
      tenants: NOT_FOUND,
    });
    const res = mockRes();
    await login({ body: { email: 'landlord@x.com', password: 'wrong-password' } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid email or password.' });
    expect(builders.landlords.update).toHaveBeenCalledWith(
      expect.objectContaining({ failed_login_attempts: 1 })
    );
  });

  test('locks the account after 3 failed attempts, and rejects further attempts while locked', async () => {
    const landlord = {
      id: 'L1', email: 'landlord@x.com', phone: '254711111111',
      password_hash: 'hashed:correct-password',
      failed_login_attempts: 2, locked_until: null, // this will be the 3rd failure
      is_verified: true, subscription_status: 'active',
    };
    const builders = setupSupabaseMock(supabase, {
      ...SETTINGS_OPEN,
      landlords: { data: landlord, error: null },
      property_managers: NOT_FOUND,
      tenants: NOT_FOUND,
    });
    const res = mockRes();
    await login({ body: { email: 'landlord@x.com', password: 'wrong-password' } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(builders.landlords.update).toHaveBeenCalledWith(
      expect.objectContaining({ failed_login_attempts: 3, locked_until: expect.any(String) })
    );
  });

  test('rejects login outright while locked_until is still in the future, even with the correct password', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const landlord = {
      id: 'L1', email: 'landlord@x.com', phone: '254711111111',
      password_hash: 'hashed:correct-password',
      failed_login_attempts: 3, locked_until: future,
      is_verified: true, subscription_status: 'active',
    };
    setupSupabaseMock(supabase, {
      ...SETTINGS_OPEN,
      landlords: { data: landlord, error: null },
      property_managers: NOT_FOUND,
      tenants: NOT_FOUND,
    });
    const res = mockRes();
    await login({ body: { email: 'landlord@x.com', password: 'correct-password' } }, res);
    expect(res.status).toHaveBeenCalledWith(423);
  });

  test('rejects a landlord an admin suspended, even with the correct password', async () => {
    const landlord = {
      id: 'L1', email: 'landlord@x.com', phone: '254711111111',
      password_hash: 'hashed:correct-password',
      failed_login_attempts: 0, locked_until: null,
      is_verified: true, subscription_status: 'suspended',
    };
    setupSupabaseMock(supabase, {
      ...SETTINGS_OPEN,
      landlords: { data: landlord, error: null },
      property_managers: NOT_FOUND,
      tenants: NOT_FOUND,
    });
    const res = mockRes();
    await login({ body: { email: 'landlord@x.com', password: 'correct-password' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ suspended: true }));
  });

  test('a landlord whose subscription payment is still pending gets routed to the payment-pending screen, not the dashboard', async () => {
    const landlord = {
      id: 'L1', email: 'landlord@x.com', phone: '254711111111',
      password_hash: 'hashed:correct-password',
      failed_login_attempts: 0, locked_until: null,
      is_verified: true, subscription_status: 'pending',
      unit_limit: 5, subscription_period_months: 1,
    };
    setupSupabaseMock(supabase, {
      ...SETTINGS_OPEN,
      landlords: { data: landlord, error: null },
      property_managers: NOT_FOUND,
      tenants: NOT_FOUND,
      subscription_payments: { data: { mpesa_checkout_request_id: 'CHK123', amount: 4500 }, error: null },
    });
    const res = mockRes();
    await login({ body: { email: 'landlord@x.com', password: 'correct-password' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ paymentPending: true, landlordId: 'L1', checkoutRequestId: 'CHK123' })
    );
  });

  test('a correct password on an active, verified landlord succeeds and returns a token', async () => {
    const landlord = {
      id: 'L1', email: 'landlord@x.com', phone: '254711111111',
      password_hash: 'hashed:correct-password',
      failed_login_attempts: 0, locked_until: null,
      is_verified: true, subscription_status: 'active',
      must_change_password: false, setup_wizard_complete: true,
    };
    setupSupabaseMock(supabase, {
      ...SETTINGS_OPEN,
      landlords: { data: landlord, error: null },
      property_managers: NOT_FOUND,
      tenants: NOT_FOUND,
    });
    const res = mockRes();
    await login({ body: { email: 'landlord@x.com', password: 'correct-password' } }, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'fake.jwt.token', role: 'landlord', phone: '254711111111' })
    );
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  test('an unverified tenant gets an OTP re-sent instead of a bare rejection', async () => {
    const tenant = {
      id: 'T1', email: 'tenant@x.com', primary_phone: '254722222222',
      password_hash: 'hashed:correct-password',
      failed_login_attempts: 0, locked_until: null,
      is_verified: false, is_active: true,
      otp_code: null, otp_expires_at: null,
    };
    setupSupabaseMock(supabase, {
      ...SETTINGS_OPEN,
      landlords: NOT_FOUND,
      property_managers: NOT_FOUND,
      tenants: { data: tenant, error: null },
    });
    const res = mockRes();
    await login({ body: { email: 'tenant@x.com', password: 'correct-password' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ needsVerification: true, accountType: 'tenant', accountId: 'T1' })
    );
  });

  test('a phone number shared by two account types with the SAME password on both is a genuine ambiguity: neither is chosen automatically', async () => {
    const sharedHash = 'hashed:shared-password';
    const landlord = {
      id: 'L1', email: 'shared@x.com', phone: '254733333333',
      password_hash: sharedHash, failed_login_attempts: 0, locked_until: null,
      is_verified: true, subscription_status: 'active',
    };
    const manager = {
      id: 'M1', email: 'shared@x.com', phone: '254733333333',
      password_hash: sharedHash, failed_login_attempts: 0, locked_until: null,
      is_verified: true, is_active: true, role_level: 'manager', landlord_id: 'L2',
    };
    setupSupabaseMock(supabase, {
      ...SETTINGS_OPEN,
      landlords: { data: landlord, error: null },
      property_managers: { data: manager, error: null },
      tenants: NOT_FOUND,
    });
    const res = mockRes();
    await login({ body: { email: 'shared@x.com', password: 'shared-password' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        needsAccountPicker: true,
        options: expect.arrayContaining([
          expect.objectContaining({ accountType: 'landlord', id: 'L1' }),
          expect.objectContaining({ accountType: 'manager', id: 'M1' }),
        ]),
      })
    );
  });
});
