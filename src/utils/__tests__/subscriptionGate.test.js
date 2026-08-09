// src/utils/__tests__/subscriptionGate.test.js
//
// Covers getExpiredPropertyIds - the batched (one-query, not
// one-per-property) replacement for calling isSubscriptionExpiredFor
// in a loop (see propertyManager.controller.js).

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../config/supabase');
const { setupSupabaseMock } = require('../../test-utils/supabaseMock');
const { getExpiredPropertyIds } = require('../subscriptionGate');

describe('getExpiredPropertyIds', () => {
  test('returns [] immediately for an empty id list without querying', async () => {
    const builders = setupSupabaseMock(supabase, {});
    const result = await getExpiredPropertyIds('L1', []);
    expect(result).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a property with its own clock (unit_limit set) is judged on its own subscription_status, not the landlord\'s', async () => {
    const builders = setupSupabaseMock(supabase, {
      properties: {
        data: [
          { id: 'P1', unit_limit: 5, subscription_status: 'expired' },
          { id: 'P2', unit_limit: 5, subscription_status: 'active' },
        ],
        error: null,
      },
    });
    const result = await getExpiredPropertyIds('L1', ['P1', 'P2']);
    expect(result).toEqual(['P1']);
    // No per-property-owned properties need the landlord's own status,
    // so that second query should never have been made.
    expect(builders.landlords).toBeUndefined();
  });

  test('a property with no per-property clock falls back to the landlord-wide status, checked once for all such properties', async () => {
    const builders = setupSupabaseMock(supabase, {
      properties: {
        data: [
          { id: 'P1', unit_limit: null, subscription_status: null },
          { id: 'P2', unit_limit: null, subscription_status: null },
        ],
        error: null,
      },
      landlords: { data: { subscription_status: 'expired' }, error: null },
    });
    const result = await getExpiredPropertyIds('L1', ['P1', 'P2']);
    expect(result.sort()).toEqual(['P1', 'P2']);
    // One query for properties, one for the landlord - not one per property.
    expect(supabase.from).toHaveBeenCalledWith('properties');
    expect(supabase.from).toHaveBeenCalledWith('landlords');
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  test('a mix of own-clock and shared-clock properties resolves each correctly in one pass', async () => {
    setupSupabaseMock(supabase, {
      properties: {
        data: [
          { id: 'P1', unit_limit: 5, subscription_status: 'active' }, // own clock, fine
          { id: 'P2', unit_limit: null, subscription_status: null }, // shared clock, landlord expired
        ],
        error: null,
      },
      landlords: { data: { subscription_status: 'expired' }, error: null },
    });
    const result = await getExpiredPropertyIds('L1', ['P1', 'P2']);
    expect(result).toEqual(['P2']);
  });
});
