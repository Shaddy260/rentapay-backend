// src/controllers/__tests__/baAdminPayout.markBaPeriod.test.js
//
// PHASE 12 QA CHECKLIST:
//   "Admin's Mark as Paid / Not Paid action is idempotent and records
//   who/when."
//   "Marking a BA period as Paid twice in a row (double-click or
//   retry) does not double-count the payout."
//
// markBaPeriod (markBaPeriodPaid/markBaPeriodNotPaid) is meant to be
// safe under three different shapes of "did this already happen?":
//   1. An application-level check: a plain second request sees the
//      existing mark and short-circuits with alreadyPaid:true,
//      touching no claim rows and creating no second mark.
//   2. A genuine DB-level race: two near-simultaneous requests both
//      pass the application-level check (neither sees the other's
//      write yet) and both attempt an INSERT - the unique (ba_id,
//      period_type, period_key) constraint on ba_payout_period_marks
//      is what actually prevents a duplicate row, surfaced to
//      Postgres error code 23505, which the controller must catch
//      and treat as "already paid", not a 500.
//   3. Marking it back to 'not_paid' correctly clears marked_paid_by
//      / marked_paid_at rather than leaving stale audit fields.

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/activityLog.service', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/sentry.service', () => ({ captureException: jest.fn() }));
jest.mock('../../services/pdfReport.service', () => ({ generateEarningsStatementPdf: jest.fn() }));

const supabase = require('../../config/supabase');
const { logActivity } = require('../../services/activityLog.service');
const { setupSupabaseMock } = require('../../test-utils/supabaseMock');
const { markBaPeriodPaid, markBaPeriodNotPaid } = require('../baAdminPayout.controller');

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function mockReq({ baId = 'BA1', periodType = 'month', periodKey = '2026-06', claimIds = ['C1', 'C2'] } = {}) {
  return { params: { baId }, body: { periodType, periodKey, claimIds }, ip: '127.0.0.1' };
}

const QUALIFIED_AT_IN_JUNE = '2026-06-15T00:00:00.000Z';

function claimsRow(overrides = {}) {
  return {
    id: 'C1',
    ba_id: 'BA1',
    qualification_status: 'qualified',
    qualified_at: QUALIFIED_AT_IN_JUNE,
    payout_amount: 1500,
    commission_bonus_amount: 0,
    ...overrides,
  };
}

describe('markBaPeriod (markBaPeriodPaid / markBaPeriodNotPaid)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('first call with no existing mark creates one, marks claims paid, and records who/when', async () => {
    const builders = setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: null, error: null }, // no existing mark
      ba_landlord_claims: { data: [claimsRow({ id: 'C1' }), claimsRow({ id: 'C2' })], error: null },
    });
    builders.ba_payout_period_marks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    builders.ba_payout_period_marks.single.mockResolvedValueOnce({
      data: {
        id: 'MARK1',
        ba_id: 'BA1',
        period_type: 'month',
        period_key: '2026-06',
        status: 'paid',
        claim_ids: ['C1', 'C2'],
        base_total: 3000,
        commission_total: 0,
        grand_total: 3000,
        marked_paid_by: 'super-admin',
        marked_paid_at: expect.any(String),
      },
      error: null,
    });

    const res = mockRes();
    await markBaPeriodPaid(mockReq(), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ mark: expect.objectContaining({ status: 'paid' }) }));

    // Claims actually get flipped to 'paid' with who/when recorded.
    expect(builders.ba_landlord_claims.update).toHaveBeenCalledWith(
      expect.objectContaining({ qualification_status: 'paid', marked_paid_by: 'super-admin', marked_paid_at: expect.any(String) })
    );

    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'ba_payout_period_marked_paid' }));
  });

  test('APPLICATION-LEVEL IDEMPOTENCY: a second call after the period is already marked paid short-circuits without touching claims', async () => {
    const existingMark = {
      id: 'MARK1',
      ba_id: 'BA1',
      period_type: 'month',
      period_key: '2026-06',
      status: 'paid',
      claim_ids: ['C1', 'C2'],
      base_total: 3000,
      commission_total: 0,
      grand_total: 3000,
      marked_paid_by: 'super-admin',
      marked_paid_at: '2026-06-20T10:00:00.000Z',
    };
    const builders = setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: existingMark, error: null },
      ba_landlord_claims: { data: [claimsRow()], error: null },
    });
    builders.ba_payout_period_marks.maybeSingle.mockResolvedValueOnce({ data: existingMark, error: null });

    const res = mockRes();
    await markBaPeriodPaid(mockReq(), res);

    expect(res.json).toHaveBeenCalledWith({ mark: existingMark, alreadyPaid: true });

    // The whole point of idempotency: no second write anywhere, and
    // no claim row is touched a second time.
    expect(builders.ba_landlord_claims.update).not.toHaveBeenCalled();
    expect(builders.ba_payout_period_marks.insert).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  test('DB-LEVEL RACE: a unique-constraint violation on insert (23505) is treated as already-paid, not a 500', async () => {
    const raced = {
      id: 'MARK1',
      ba_id: 'BA1',
      period_type: 'month',
      period_key: '2026-06',
      status: 'paid',
      claim_ids: ['C1', 'C2'],
      marked_paid_by: 'super-admin',
      marked_paid_at: '2026-06-20T10:00:01.000Z',
    };
    const builders = setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: null, error: null },
      ba_landlord_claims: { data: [claimsRow({ id: 'C1' }), claimsRow({ id: 'C2' })], error: null },
    });
    // Both requests' application-level check sees "nothing yet" -
    // that's the race window.
    builders.ba_payout_period_marks.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // this request's own initial fetch
      .mockResolvedValueOnce({ data: raced, error: null }); // its post-conflict re-fetch, after the OTHER request won
    // The insert itself fails with the real unique-constraint code.
    builders.ba_payout_period_marks.single.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    const res = mockRes();
    await markBaPeriodPaid(mockReq(), res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ mark: raced, alreadyPaid: true });
  });

  test('marking a period back to not_paid clears marked_paid_by/marked_paid_at rather than leaving stale audit fields', async () => {
    const existingPaidMark = {
      id: 'MARK1',
      ba_id: 'BA1',
      period_type: 'month',
      period_key: '2026-06',
      status: 'paid',
      claim_ids: ['C1'],
      marked_paid_by: 'super-admin',
      marked_paid_at: '2026-06-20T10:00:00.000Z',
    };
    const builders = setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: existingPaidMark, error: null },
      ba_landlord_claims: { data: [claimsRow({ id: 'C1', qualification_status: 'paid' })], error: null },
    });
    builders.ba_payout_period_marks.maybeSingle.mockResolvedValueOnce({ data: existingPaidMark, error: null });
    builders.ba_payout_period_marks.single.mockResolvedValueOnce({
      data: { ...existingPaidMark, status: 'not_paid', marked_paid_by: null, marked_paid_at: null },
      error: null,
    });

    const res = mockRes();
    await markBaPeriodNotPaid(mockReq({ claimIds: ['C1'] }), res);

    expect(builders.ba_payout_period_marks.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not_paid', marked_paid_by: null, marked_paid_at: null })
    );
    expect(builders.ba_landlord_claims.update).toHaveBeenCalledWith(
      expect.objectContaining({ qualification_status: 'not_paid', marked_paid_by: null, marked_paid_at: null })
    );
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'ba_payout_period_marked_not_paid' }));
  });

  test('rejects a claim that does not belong to this BA rather than silently marking it', async () => {
    setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: null, error: null },
      ba_landlord_claims: { data: [claimsRow({ id: 'C1', ba_id: 'SOME_OTHER_BA' })], error: null },
    });

    const res = mockRes();
    await markBaPeriodPaid(mockReq({ claimIds: ['C1'] }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/does not belong/i) }));
  });

  test('rejects a claim whose qualified_at falls outside the selected period', async () => {
    setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: null, error: null },
      ba_landlord_claims: { data: [claimsRow({ id: 'C1', qualified_at: '2026-05-01T00:00:00.000Z' })], error: null },
    });

    const res = mockRes();
    await markBaPeriodPaid(mockReq({ periodType: 'month', periodKey: '2026-06', claimIds: ['C1'] }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/does not fall in the selected period/i) }));
  });
});
