// src/controllers/__tests__/brandAmbassador.submitBaOnboarding.race.test.js
//
// PHASE 12 QA CHECKLIST: "Two near-simultaneous BA applications with
// the same phone/email cannot both succeed — the database-level
// constraint (not just the application check) is what actually
// prevents this."
//
// The application-level findPhoneConflict/findEmailConflict check
// (Promise.all in submitBaOnboarding) is NOT what actually guarantees
// this - it's a read, so two requests arriving close enough together
// can both read "no conflict" before either has written its row. The
// real guard is the partial unique index on brand_ambassadors(phone)
// / (lower(email)) WHERE status <> 'rejected' (see
// sql/add-brand-ambassador-role.sql), which Postgres enforces
// atomically at INSERT time regardless of what either request's
// earlier read saw.
//
// This test simulates exactly that race: both application-level
// checks report "clear" (as they would for two requests that
// genuinely landed within the same read window), and the INSERT
// itself is what fails, with the real Postgres unique-violation code
// (23505). The controller must turn that into a clear 409 duplicate
// response, not a 500 - and must not swallow it as if the row were
// created.

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../utils/phoneUniqueness', () => ({ findPhoneConflict: jest.fn() }));
jest.mock('../../utils/emailUniqueness', () => ({ findEmailConflict: jest.fn() }));
jest.mock('../../services/email.service', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
  wrapEmailHtml: jest.fn((html) => html),
  SUPPORT_EMAIL: 'support@example.com',
}));
jest.mock('../../services/sms.service', () => ({ sendSMS: jest.fn() }));
jest.mock('../../services/activityLog.service', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/sentry.service', () => ({ captureException: jest.fn() }));
jest.mock('../../services/notify.service', () => ({ notify: jest.fn().mockResolvedValue(undefined) }));

const supabase = require('../../config/supabase');
const { findPhoneConflict } = require('../../utils/phoneUniqueness');
const { findEmailConflict } = require('../../utils/emailUniqueness');
const { setupSupabaseMock } = require('../../test-utils/supabaseMock');
const { submitBaOnboarding } = require('../brandAmbassador.controller');

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function mockReq(overrides = {}) {
  return {
    body: {
      fullName: 'Jane Applicant',
      phone: '0700111222',
      email: 'jane@example.com',
      nationalId: '12345678',
      termsAccepted: true,
      emailVerification: 'TOKEN123',
      onboardingToken: 'LINK_TOKEN_ABC',
      ...overrides,
    },
  };
}

// checkOnboardingLinkToken() runs before any of the logic these tests
// actually exercise (see brandAmbassador.controller.js) - it reads the
// most recent row in ba_onboarding_links and requires its token to
// match and not be expired. Every test in this file needs this to
// pass so execution actually reaches the duplicate-application race
// logic under test, not the earlier link-validity gate.
function validOnboardingLink() {
  return {
    data: { token: 'LINK_TOKEN_ABC', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    error: null,
  };
}

describe('submitBaOnboarding - duplicate-application race condition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('THE DB-CONSTRAINT FIX: a 23505 unique-violation on insert is returned as a clear 409, never a 500 or a silently-created row', async () => {
    // Simulate the race: the application-level checks both come back
    // clear (as they would for two requests landing in the same
    // window, each reading before the other has written).
    findPhoneConflict.mockResolvedValue(null);
    findEmailConflict.mockResolvedValue(null);

    const builders = setupSupabaseMock(supabase, {
      ba_onboarding_links: validOnboardingLink(),
      ba_email_otps: { data: { verified: true, verification_token: 'TOKEN123' }, error: null },
      brand_ambassadors: { data: null, error: null },
    });
    // The INSERT itself is what actually loses the race - the DB
    // constraint, not the earlier application-level read, is what
    // catches it.
    builders.brand_ambassadors.single.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "brand_ambassadors_phone_active_uidx"' },
    });

    const res = mockRes();
    await submitBaOnboarding(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/just registered by another application/i) })
    );
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(201);
  });

  test('a non-constraint DB error on insert still surfaces as a real failure, not a false-positive duplicate message', async () => {
    findPhoneConflict.mockResolvedValue(null);
    findEmailConflict.mockResolvedValue(null);

    const builders = setupSupabaseMock(supabase, {
      ba_onboarding_links: validOnboardingLink(),
      ba_email_otps: { data: { verified: true, verification_token: 'TOKEN123' }, error: null },
      brand_ambassadors: { data: null, error: null },
    });
    builders.brand_ambassadors.single.mockResolvedValueOnce({
      data: null,
      error: { code: '08006', message: 'connection to server was lost' },
    });

    const res = mockRes();
    await submitBaOnboarding(mockReq(), res);

    // Must NOT be reported to the applicant as "someone else just
    // registered this" - that would be misleading for an unrelated
    // infra failure.
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/just registered/i) }));
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('the happy path (no race, no existing row) still succeeds normally', async () => {
    findPhoneConflict.mockResolvedValue(null);
    findEmailConflict.mockResolvedValue(null);

    const builders = setupSupabaseMock(supabase, {
      ba_onboarding_links: validOnboardingLink(),
      ba_email_otps: { data: { verified: true, verification_token: 'TOKEN123' }, error: null },
      brand_ambassadors: { data: null, error: null },
    });
    builders.brand_ambassadors.single.mockResolvedValueOnce({
      data: { id: 'BA_NEW', full_name: 'Jane Applicant', phone: '254700111222', email: 'jane@example.com', status: 'pending_approval' },
      error: null,
    });

    const res = mockRes();
    await submitBaOnboarding(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('an application-level conflict (no race needed) is still rejected before any insert is attempted', async () => {
    findPhoneConflict.mockResolvedValue('This phone number already exists on a landlord account.');
    findEmailConflict.mockResolvedValue(null);

    const builders = setupSupabaseMock(supabase, {
      ba_onboarding_links: validOnboardingLink(),
      ba_email_otps: { data: { verified: true, verification_token: 'TOKEN123' }, error: null },
      brand_ambassadors: { data: null, error: null },
    });

    const res = mockRes();
    await submitBaOnboarding(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(builders.brand_ambassadors.insert).not.toHaveBeenCalled();
  });
});
