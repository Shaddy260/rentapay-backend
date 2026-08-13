// src/controllers/__tests__/baAdminPayout.markBaPeriod.test.js
//
// PHASE 12 QA CHECKLIST:
//   "Admin's Mark as Paid / Not Paid action is idempotent and records
//   who/when."
//   "Marking a BA period as Paid twice in a row (double-click or
//   retry) does not double-count the payout."
//
// REBUILT alongside the controller's rebuild against
// ba_commission_earnings (the old ba_landlord_claims table these
// tests originally exercised no longer exists - see
// baAdminPayout.controller.js's header comment). markBaPeriod now
// reads/validates against ba_commission_earnings rows instead, and
// never writes back to them - ba_payout_period_marks IS the paid/
// not-paid record, so there is no more "claims got updated" step to
// assert on; these tests assert against ba_payout_period_marks
// (insert/update) instead.
//
// markBaPeriod (markBaPeriodPaid/markBaPeriodNotPaid) is meant to be
// safe under three different shapes of "did this already happen?":
//   1. An application-level check: a plain second request sees the
//      existing mark and short-circuits with alreadyPaid:true,
//      creating no second mark.
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
jest.mock('../../services/notify.service', () => ({ notify: jest.fn().mockResolvedValue(null) }));

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

function mockReq({ baId = 'BA1', periodType = 'month', periodKey = '2026-06', claimIds = ['E1', 'E2'] } = {}) {
  return { params: { baId }, body: { periodType, periodKey, claimIds }, ip: '127.0.0.1' };
}

const PAID_AT_IN_JUNE = '2026-06-15T00:00:00.000Z';

function earningRow(overrides = {}) {
  return {
    id: 'E1',
    ba_id: 'BA1',
    paid_at: PAID_AT_IN_JUNE,
    commission_amount: 1500,
    ...overrides,
  };
}

describe('markBaPeriod (markBaPeriodPaid / markBaPeriodNotPaid)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('first call with no existing mark creates one and records who/when', async () => {
    const builders = setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: null, error: null }, // no existing mark
      ba_commission_earnings: { data: [earningRow({ id: 'E1' }), earningRow({ id: 'E2' })], error: null },
    });
    builders.ba_payout_period_marks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    builders.ba_payout_period_marks.single.mockResolvedValueOnce({
      data: {
        id: 'MARK1',
        ba_id: 'BA1',
        period_type: 'month',
        period_key: '2026-06',
        status: 'paid',
        claim_ids: ['E1', 'E2'],
        base_total: 0,
        commission_total: 3000,
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

    // The mark itself is the paid record now - it's inserted with the
    // earning ids and the snapshotted commission total.
    expect(builders.ba_payout_period_marks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paid', claim_ids: ['E1', 'E2'], commission_total: 3000, marked_paid_by: 'super-admin' })
    );

    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'ba_payout_period_marked_paid' }));
  });

  test('APPLICATION-LEVEL IDEMPOTENCY: a second call after the period is already marked paid short-circuits', async () => {
    const existingMark = {
      id: 'MARK1',
      ba_id: 'BA1',
      period_type: 'month',
      period_key: '2026-06',
      status: 'paid',
      claim_ids: ['E1', 'E2'],
      base_total: 0,
      commission_total: 3000,
      grand_total: 3000,
      marked_paid_by: 'super-admin',
      marked_paid_at: '2026-06-20T10:00:00.000Z',
    };
    const builders = setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: existingMark, error: null },
      ba_commission_earnings: { data: [earningRow()], error: null },
    });
    builders.ba_payout_period_marks.maybeSingle.mockResolvedValueOnce({ data: existingMark, error: null });

    const res = mockRes();
    await markBaPeriodPaid(mockReq(), res);

    expect(res.json).toHaveBeenCalledWith({ mark: existingMark, alreadyPaid: true });

    // The whole point of idempotency: no second write anywhere.
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
      claim_ids: ['E1', 'E2'],
      marked_paid_by: 'super-admin',
      marked_paid_at: '2026-06-20T10:00:01.000Z',
    };
    const builders = setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: null, error: null },
      ba_commission_earnings: { data: [earningRow({ id: 'E1' }), earningRow({ id: 'E2' })], error: null },
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
      claim_ids: ['E1'],
      marked_paid_by: 'super-admin',
      marked_paid_at: '2026-06-20T10:00:00.000Z',
    };
    const builders = setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: existingPaidMark, error: null },
      ba_commission_earnings: { data: [earningRow({ id: 'E1' })], error: null },
    });
    builders.ba_payout_period_marks.maybeSingle.mockResolvedValueOnce({ data: existingPaidMark, error: null });
    builders.ba_payout_period_marks.single.mockResolvedValueOnce({
      data: { ...existingPaidMark, status: 'not_paid', marked_paid_by: null, marked_paid_at: null },
      error: null,
    });

    const res = mockRes();
    await markBaPeriodNotPaid(mockReq({ claimIds: ['E1'] }), res);

    expect(builders.ba_payout_period_marks.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not_paid', marked_paid_by: null, marked_paid_at: null })
    );
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'ba_payout_period_marked_not_paid' }));
  });

  test('rejects an earning that does not belong to this BA rather than silently marking it', async () => {
    setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: null, error: null },
      ba_commission_earnings: { data: [earningRow({ id: 'E1', ba_id: 'SOME_OTHER_BA' })], error: null },
    });

    const res = mockRes();
    await markBaPeriodPaid(mockReq({ claimIds: ['E1'] }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/does not belong/i) }));
  });

  test('rejects an earning whose paid_at falls outside the selected period', async () => {
    setupSupabaseMock(supabase, {
      ba_payout_period_marks: { data: null, error: null },
      ba_commission_earnings: { data: [earningRow({ id: 'E1', paid_at: '2026-05-01T00:00:00.000Z' })], error: null },
    });

    const res = mockRes();
    await markBaPeriodPaid(mockReq({ periodType: 'month', periodKey: '2026-06', claimIds: ['E1'] }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/does not fall in the selected period/i) }));
  });
});
