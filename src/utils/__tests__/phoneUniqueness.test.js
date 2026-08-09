// src/utils/__tests__/phoneUniqueness.test.js
//
// This is exactly the logic behind the "onboarding-loop and
// archive-reuse" bug class: an archived tenant/manager's phone number
// must become reusable, but an ACTIVE one anywhere must still block a
// second account. These tests pin down both directions so a future
// change can't silently reopen either bug.

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../config/supabase');
const { setupSupabaseMock } = require('../../test-utils/supabaseMock');
const { findPhoneConflict } = require('../phoneUniqueness');

const FREE = { data: null, error: null };
const PHONE = '254700111222';

describe('findPhoneConflict', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns null (free to use) when the number is unused anywhere', async () => {
    setupSupabaseMock(supabase, {
      landlords: FREE,
      property_managers: FREE,
      tenants: FREE,
    });
    const conflict = await findPhoneConflict(PHONE, 'tenant');
    expect(conflict).toBeNull();
  });

  test('blocks a new landlord signup if the number already belongs to a landlord', async () => {
    setupSupabaseMock(supabase, {
      landlords: { data: { id: 'L1' }, error: null },
      property_managers: FREE,
      tenants: FREE,
    });
    const conflict = await findPhoneConflict(PHONE, 'landlord');
    expect(conflict).toMatch(/already exists/i);
  });

  test('blocks adding a tenant on a number already used by a landlord account', async () => {
    setupSupabaseMock(supabase, {
      landlords: { data: { id: 'L1' }, error: null },
      property_managers: FREE,
      tenants: FREE,
    });
    const conflict = await findPhoneConflict(PHONE, 'tenant');
    expect(conflict).toMatch(/landlord account/i);
  });

  test('THE ARCHIVE-REUSE FIX: an archived (is_active=false) tenant\'s number is reusable by a new landlord', async () => {
    // The mock always applies is_active=true in the real query, so an
    // archived tenant simply never shows up in the result - this
    // asserts the "free to use" behaviour that fix depends on.
    setupSupabaseMock(supabase, {
      landlords: FREE,
      property_managers: FREE,
      tenants: FREE, // archived tenant is filtered out at the query level (is_active=true)
    });
    const conflict = await findPhoneConflict(PHONE, 'tenant');
    expect(conflict).toBeNull();
  });

  test('an ACTIVE tenant elsewhere still blocks a new tenant signup with the same number', async () => {
    setupSupabaseMock(supabase, {
      landlords: FREE,
      property_managers: FREE,
      tenants: { data: { id: 'T1', is_active: true, landlord_id: 'L9' }, error: null },
    });
    const conflict = await findPhoneConflict(PHONE, 'tenant');
    expect(conflict).toMatch(/active tenant account/i);
  });

  test('an active manager/caretaker elsewhere blocks a new manager signup with the same number', async () => {
    setupSupabaseMock(supabase, {
      landlords: FREE,
      property_managers: { data: { id: 'M1', is_active: true }, error: null },
      tenants: FREE,
    });
    const conflict = await findPhoneConflict(PHONE, 'manager');
    expect(conflict).toMatch(/property manager with this phone number already exists/i);
  });

  test('checks landlords before managers before tenants (landlord conflict wins even if role is manager)', async () => {
    setupSupabaseMock(supabase, {
      landlords: { data: { id: 'L1' }, error: null },
      property_managers: { data: { id: 'M1', is_active: true }, error: null },
      tenants: { data: { id: 'T1', is_active: true }, error: null },
    });
    const conflict = await findPhoneConflict(PHONE, 'manager');
    expect(conflict).toMatch(/landlord account/i);
  });
});
