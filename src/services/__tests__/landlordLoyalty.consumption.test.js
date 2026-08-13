// src/services/__tests__/landlordLoyalty.consumption.test.js
//
// P6 (loyalty-discount-roadmap.md): "No tests exist yet for the
// one-time-consumption logic." Covers the two functions in
// landlordLoyalty.service.js most directly responsible for a
// landlord never losing (or double-losing) a granted discount:
//
//   - consumeLoyaltyDiscount: consumes on first call, no-ops
//     (returns null, never throws) on a second call against an
//     already-inactive row.
//   - getReminderForLandlord: returns null when there's no active,
//     unexpired, unsnoozed discount to remind about.
//
// The callback/manual-payment CONTROLLERS that decide WHEN to call
// consumeLoyaltyDiscount (never on a failed STK push, only on the
// renewal branch of a confirmed manual payment) are covered by their
// own dedicated test files below in this same P6 pass - this file is
// about the consumption primitive itself being safe to call.

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/notify.service', () => ({ notify: jest.fn().mockResolvedValue(undefined) }));

const supabase = require('../../config/supabase');
const { setupSupabaseMock } = require('../../test-utils/supabaseMock');
const {
  consumeLoyaltyDiscount,
  getReminderForLandlord,
} = require('../landlordLoyalty.service');

describe('consumeLoyaltyDiscount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('consumes an active discount on first call and stamps the consuming payment id', async () => {
    const consumedRow = {
      id: 'disc-1',
      is_active: false,
      consumed_at: '2026-08-13T00:00:00.000Z',
      consumed_by_subscription_payment_id: 'sub-pay-1',
    };
    const builders = setupSupabaseMock(supabase, {
      landlord_loyalty_discounts: { data: consumedRow, error: null },
    });

    const result = await consumeLoyaltyDiscount('disc-1', { subscriptionPaymentId: 'sub-pay-1' });

    expect(result).toEqual(consumedRow);
    expect(builders.landlord_loyalty_discounts.update).toHaveBeenCalledWith(
      expect.objectContaining({
        is_active: false,
        consumed_by_subscription_payment_id: 'sub-pay-1',
        consumed_by_manual_payment_id: null,
        consumed_by_property_payment_id: null,
      })
    );
    // The write is scoped to is_active=true - this is what makes a
    // second call against the same row a guaranteed no-op at the DB
    // level (0 rows match), not just at the application level.
    expect(builders.landlord_loyalty_discounts.eq).toHaveBeenCalledWith('id', 'disc-1');
    expect(builders.landlord_loyalty_discounts.eq).toHaveBeenCalledWith('is_active', true);
  });

  test('a second call against an already-inactive row returns null and does not throw', async () => {
    // .eq('is_active', true) matches nothing once the row is already
    // inactive - supabase-js reports that as a successful query with
    // no error and data: null (maybeSingle), never an error.
    setupSupabaseMock(supabase, {
      landlord_loyalty_discounts: { data: null, error: null },
    });

    const result = await consumeLoyaltyDiscount('disc-1', { manualPaymentId: 'manual-1' });

    expect(result).toBeNull();
  });

  test('a null/undefined discountId is a no-op and never queries the database', async () => {
    setupSupabaseMock(supabase, {});

    const result = await consumeLoyaltyDiscount(null, {});

    expect(result).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a database error is swallowed - consuming a discount must never block the payment flow', async () => {
    setupSupabaseMock(supabase, {
      landlord_loyalty_discounts: { data: null, error: { message: 'connection reset' } },
    });

    await expect(consumeLoyaltyDiscount('disc-1', {})).resolves.toBeNull();
  });
});

describe('getReminderForLandlord', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns null when the landlord has no active discount at all', async () => {
    setupSupabaseMock(supabase, {
      landlord_loyalty_discounts: { data: null, error: null },
    });

    const reminder = await getReminderForLandlord('landlord-1');

    expect(reminder).toBeNull();
  });

  test('returns null when the active discount is currently snoozed', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setupSupabaseMock(supabase, {
      landlord_loyalty_discounts: {
        data: {
          id: 'disc-1',
          discount_percentage: 10,
          granted_at: '2026-08-01T00:00:00.000Z',
          reminder_snoozed_until: future,
          expires_at: null,
        },
        error: null,
      },
    });

    const reminder = await getReminderForLandlord('landlord-1');

    expect(reminder).toBeNull();
  });

  test('returns a reminder payload (with daysUntilExpiry) when active, unsnoozed, and unexpired', async () => {
    const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    setupSupabaseMock(supabase, {
      landlord_loyalty_discounts: {
        data: {
          id: 'disc-1',
          discount_percentage: 10,
          granted_at: '2026-08-01T00:00:00.000Z',
          reminder_snoozed_until: null,
          expires_at: expiresAt,
        },
        error: null,
      },
    });

    const reminder = await getReminderForLandlord('landlord-1');

    expect(reminder).toMatchObject({ discountId: 'disc-1', discountPercentage: 10 });
    expect(reminder.daysUntilExpiry).toBeGreaterThanOrEqual(4);
    expect(reminder.daysUntilExpiry).toBeLessThanOrEqual(5);
  });

  test('a missing landlordId returns null and never queries the database', async () => {
    setupSupabaseMock(supabase, {});

    const reminder = await getReminderForLandlord(undefined);

    expect(reminder).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
