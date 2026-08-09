// src/utils/__tests__/emailUniqueness.test.js
//
// Mirrors phoneUniqueness.test.js - see that file's header for why
// this specific pair of behaviors (archived accounts are reusable,
// active accounts anywhere are not) is the highest-value thing to
// pin down here.

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../config/supabase');
const { setupSupabaseMock } = require('../../test-utils/supabaseMock');
const { findEmailConflict } = require('../emailUniqueness');

const FREE = { data: null, error: null };
const EMAIL = 'person@example.com';

describe('findEmailConflict', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns null immediately for an empty/blank email without querying', async () => {
    const conflict = await findEmailConflict('   ', 'tenant');
    expect(conflict).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('returns null (free to use) when the email is unused anywhere', async () => {
    setupSupabaseMock(supabase, {
      landlords: FREE,
      property_managers: FREE,
      tenants: FREE,
    });
    const conflict = await findEmailConflict(EMAIL, 'tenant');
    expect(conflict).toBeNull();
  });

  test('blocks a second active tenant account from reusing an email already active elsewhere', async () => {
    setupSupabaseMock(supabase, {
      landlords: FREE,
      property_managers: FREE,
      tenants: { data: { id: 'T1', is_active: true, landlord_id: 'L9' }, error: null },
    });
    const conflict = await findEmailConflict(EMAIL, 'tenant');
    expect(conflict).toMatch(/active tenant account/i);
  });

  test('an archived tenant\'s email is reusable (the reputation-blending bug this guards against)', async () => {
    setupSupabaseMock(supabase, {
      landlords: FREE,
      property_managers: FREE,
      tenants: FREE, // archived rows are filtered out by is_active=true at the query level
    });
    const conflict = await findEmailConflict(EMAIL, 'tenant');
    expect(conflict).toBeNull();
  });

  test('a landlord email conflict blocks a manager signup with a role-specific message', async () => {
    setupSupabaseMock(supabase, {
      landlords: { data: { id: 'L1' }, error: null },
      property_managers: FREE,
      tenants: FREE,
    });
    const conflict = await findEmailConflict(EMAIL, 'manager');
    expect(conflict).toMatch(/landlord account/i);
  });

  test('matching is case-insensitive: uppercase input is normalized before querying', async () => {
    const builders = setupSupabaseMock(supabase, {
      landlords: FREE,
      property_managers: FREE,
      tenants: FREE,
    });
    await findEmailConflict('Person@EXAMPLE.com', 'tenant');
    expect(builders.landlords.ilike).toHaveBeenCalledWith('email', 'person@example.com');
  });
});
