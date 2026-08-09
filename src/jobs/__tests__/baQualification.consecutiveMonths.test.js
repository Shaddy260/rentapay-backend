// src/jobs/__tests__/baQualification.consecutiveMonths.test.js
//
// PHASE 12 QA CHECKLIST: "The background qualification job only
// qualifies claims with genuinely CONSECUTIVE months paid, not just
// any N payments with a gap."
//
// computeConsecutiveMonths is a pure function (no supabase calls), so
// this pins down its chain/reset behavior directly against the exact
// payment shapes the live job feeds it - completed payments only,
// sorted ascending by paid_at, each with a paid_at + period_months.
//
// Deliberately does NOT mock supabase or exercise the rest of the
// job - the DB-backed qualify/skip/tier-cross behavior around this
// function is integration-shaped and out of scope for a unit test;
// this file is about the counting rule itself, which is where a
// silent regression would be most dangerous (it would silently
// qualify - and pay out - claims that don't actually deserve it).

// baQualification.job.js requires config/supabase at module load time,
// which (with no real env vars set in a test run) would call
// process.exit(1) - see src/config/supabase.js. Mocking it out (and
// the other services the file requires) is purely to make the module
// safely require-able here; none of these are exercised by the pure
// function under test below.
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/activityLog.service', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/notify.service', () => ({ notify: jest.fn() }));
jest.mock('../../services/notificationBatch.service', () => ({ queueBatchedNotification: jest.fn() }));
jest.mock('../../services/sentry.service', () => ({ captureException: jest.fn() }));

const { computeConsecutiveMonths } = require('../baQualification.job');

// Small helper: builds a completed payment row the same shape the
// live job selects from subscription_payments.
function payment(paidAtIso, periodMonths) {
  return { paid_at: paidAtIso, period_months: periodMonths, status: 'completed' };
}

describe('computeConsecutiveMonths', () => {
  test('a single payment counts its own period_months', () => {
    const months = computeConsecutiveMonths([payment('2026-01-01T00:00:00.000Z', 2)]);
    expect(months).toBe(2);
  });

  test('back-to-back monthly payments with no gap chain together', () => {
    const payments = [
      payment('2026-01-01T00:00:00.000Z', 1), // covers Jan 1 - Feb 1
      payment('2026-02-01T00:00:00.000Z', 1), // covers Feb 1 - Mar 1
      payment('2026-03-01T00:00:00.000Z', 1), // covers Mar 1 - Apr 1
    ];
    expect(computeConsecutiveMonths(payments)).toBe(3);
  });

  test('an early renewal (paid a few days before coverage would lapse) still chains', () => {
    // Coverage from payment 1 ends 2026-02-01; payment 2 lands two
    // days early on 2026-01-30 - within the 3-day grace window, so it
    // must still count as continuing the same unbroken run.
    const payments = [
      payment('2026-01-01T00:00:00.000Z', 1),
      payment('2026-01-30T00:00:00.000Z', 1),
    ];
    expect(computeConsecutiveMonths(payments)).toBe(2);
  });

  test('THE CORE FIX: a real gap after coverage lapses resets the chain instead of accumulating', () => {
    // Payment 1 covers Jan 1 - Feb 1. Payment 2 doesn't land until
    // May 1 - a genuine 3-month lapse, well outside the grace window.
    // A naive "just count total payments x their months" implementation
    // would wrongly report 1 + 1 = 2 (or more) months of unbroken
    // coverage; the correct behavior is that only the payment(s) AFTER
    // the gap count, since the chain restarted from scratch there.
    const payments = [
      payment('2026-01-01T00:00:00.000Z', 1),
      payment('2026-05-01T00:00:00.000Z', 1),
    ];
    expect(computeConsecutiveMonths(payments)).toBe(1);
  });

  test('a gap followed by several genuinely consecutive payments only counts the unbroken run after the gap', () => {
    const payments = [
      payment('2026-01-01T00:00:00.000Z', 1), // orphaned by the gap below
      payment('2026-06-01T00:00:00.000Z', 1), // chain restarts here
      payment('2026-07-01T00:00:00.000Z', 1),
      payment('2026-08-01T00:00:00.000Z', 1),
    ];
    expect(computeConsecutiveMonths(payments)).toBe(3);
  });

  test('a gap exactly one day past the 3-day grace window still resets the chain', () => {
    // Coverage from a 1-month payment on Jan 1 ends Feb 1. Grace is 3
    // days, so Feb 4 is still within grace; Feb 5 is not.
    const payments = [
      payment('2026-01-01T00:00:00.000Z', 1),
      payment('2026-02-05T00:00:00.000Z', 1),
    ];
    expect(computeConsecutiveMonths(payments)).toBe(1);
  });

  test('a payment landing exactly at the edge of the grace window still chains', () => {
    const payments = [
      payment('2026-01-01T00:00:00.000Z', 1), // coverage ends 2026-02-01T00:00:00.000Z
      payment('2026-02-04T00:00:00.000Z', 1), // exactly +3 days - still within grace
    ];
    expect(computeConsecutiveMonths(payments)).toBe(2);
  });

  test('multi-month periods (e.g. a 3-month plan) contribute their full period_months to the chain', () => {
    const payments = [
      payment('2026-01-01T00:00:00.000Z', 3), // covers Jan 1 - Apr 1
      payment('2026-04-01T00:00:00.000Z', 3), // covers Apr 1 - Jul 1
    ];
    expect(computeConsecutiveMonths(payments)).toBe(6);
  });

  test('rows missing paid_at or period_months are skipped rather than breaking the chain', () => {
    const payments = [
      payment('2026-01-01T00:00:00.000Z', 1),
      { paid_at: null, period_months: 1, status: 'completed' }, // malformed - must be ignored
      { paid_at: '2026-02-01T00:00:00.000Z', period_months: null, status: 'completed' }, // malformed - must be ignored
      payment('2026-02-01T00:00:00.000Z', 1),
    ];
    expect(computeConsecutiveMonths(payments)).toBe(2);
  });

  test('an empty payment history yields zero months', () => {
    expect(computeConsecutiveMonths([])).toBe(0);
  });
});
