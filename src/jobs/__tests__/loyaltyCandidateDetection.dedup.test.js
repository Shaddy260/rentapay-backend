// src/jobs/__tests__/loyaltyCandidateDetection.dedup.test.js
//
// P6 coverage for P5's job. filterNewCandidates is a pure function
// (no supabase calls), so - same rationale as
// baQualification.consecutiveMonths.test.js - this pins down the
// "only resurface a candidate the admin hasn't been told about yet,
// or who has progressed since the last time they were told" rule
// directly, without needing to mock the database.

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/activityLog.service', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/notify.service', () => ({ notify: jest.fn() }));
jest.mock('../../services/sentry.service', () => ({ captureException: jest.fn() }));
jest.mock('../../services/landlordLoyalty.service', () => ({
  findConsecutiveLandlordCandidates: jest.fn(),
  bulkGrantLoyaltyDiscount: jest.fn(),
  DEFAULT_MIN_CONSECUTIVE_MONTHS: 4,
}));

const { filterNewCandidates } = require('../loyaltyCandidateDetection.job');

function candidate(landlordId, months) {
  return { landlordId, consecutiveMonths: months };
}

describe('filterNewCandidates', () => {
  test('a landlord never notified before is always new', () => {
    const result = filterNewCandidates([candidate('L1', 5)], new Map());
    expect(result).toEqual([candidate('L1', 5)]);
  });

  test('a landlord notified at the same months figure is not re-surfaced', () => {
    const lastNotified = new Map([['L1', 5]]);
    const result = filterNewCandidates([candidate('L1', 5)], lastNotified);
    expect(result).toEqual([]);
  });

  test('a landlord notified at a LOWER months figure than today is re-surfaced (progress since last notify)', () => {
    const lastNotified = new Map([['L1', 5]]);
    const result = filterNewCandidates([candidate('L1', 9)], lastNotified);
    expect(result).toEqual([candidate('L1', 9)]);
  });

  test('a landlord notified at a HIGHER months figure than today (should not happen, but defensive) is not re-surfaced', () => {
    const lastNotified = new Map([['L1', 9]]);
    const result = filterNewCandidates([candidate('L1', 5)], lastNotified);
    expect(result).toEqual([]);
  });

  test('mixed batch: only the genuinely new/progressed candidates pass through', () => {
    const lastNotified = new Map([
      ['L1', 5], // same as today - filtered out
      ['L2', 6], // progressed to 10 - kept
    ]);
    const input = [candidate('L1', 5), candidate('L2', 10), candidate('L3', 4)]; // L3 never notified - kept
    const result = filterNewCandidates(input, lastNotified);
    expect(result).toEqual([candidate('L2', 10), candidate('L3', 4)]);
  });

  test('an empty candidate list returns an empty result', () => {
    expect(filterNewCandidates([], new Map([['L1', 5]]))).toEqual([]);
  });
});
