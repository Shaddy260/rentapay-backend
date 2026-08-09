// src/controllers/__tests__/unit.controller.extraCharge.test.js
//
// Exercises addExtraCharge's scope handling (spec item 12: 'unit' |
// 'property' | 'units') end to end against the mock supabase client,
// to catch functional regressions in how charges fan out across
// multiple units and how per-tenant balances get updated.

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/activityLog.service', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/sentry.service', () => ({ captureException: jest.fn() }));
jest.mock('../announcement.controller', () => ({ postSystemAnnouncement: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../middleware/auth.middleware', () => ({
  effectiveLandlordId: jest.fn((req) => req.user?.id),
  getManagerAssignedPropertyIds: jest.fn().mockResolvedValue([]),
  checkLandlordOwnership: jest.fn().mockResolvedValue(null),
  checkManagerPropertyAccess: jest.fn().mockResolvedValue(null),
}));

const supabase = require('../../config/supabase');
const { setupSupabaseMock } = require('../../test-utils/supabaseMock');
const { addExtraCharge } = require('../unit.controller');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

function mockReq({ unitId = 'U1', body = {} } = {}) {
  return { params: { unitId }, body, user: { id: 'L1', role: 'landlord' } };
}

describe('addExtraCharge - scope handling', () => {
  test("scope 'property': applies to every non-frozen unit on the property, skips frozen ones", async () => {
    const primaryUnit = { extra_charges: [], unit_name: 'A1', property_id: 'P1', landlord_id: 'L1', is_frozen: false };
    const propertyUnits = [
      { id: 'U1', extra_charges: [], unit_name: 'A1', is_frozen: false },
      { id: 'U2', extra_charges: [], unit_name: 'A2', is_frozen: false },
      { id: 'U3', extra_charges: [], unit_name: 'A3', is_frozen: true }, // frozen -> should be skipped
    ];
    const builders = setupSupabaseMock(supabase, {
      units: { data: primaryUnit, error: null },
      tenants: { data: null, error: null }, // no active tenant by default
    });
    builders.units.select.mockImplementation(() => builders.units);
    // First .single() call (fetch primary unit) uses __result; the
    // later plain .select() for propertyUnits query is a bare await
    // (no .single()), so needs __thenResult set to the list.
    builders.units.__setThenResult({ data: propertyUnits, error: null });

    const req = mockReq({ body: { name: 'Water', amount: 500, recurring: true, scope: 'property' } });
    const res = mockRes();
    await addExtraCharge(req, res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(payload.unitsAffected).toBe(2); // U1, U2 - U3 frozen and skipped
    expect(payload.skippedFrozenUnits).toEqual(['A3']);
  });

  test("scope 'units': rejects a unit id that doesn't belong to the property", async () => {
    const primaryUnit = { extra_charges: [], unit_name: 'A1', property_id: 'P1', landlord_id: 'L1', is_frozen: false };
    const builders = setupSupabaseMock(supabase, {
      units: { data: primaryUnit, error: null },
    });
    // The 'units' scope query (.in('id', unitIds)) only returns units
    // that actually belong to this property - simulate 'U9' (a unit
    // from another property) being silently absent from the result.
    builders.units.__setThenResult({ data: [{ id: 'U1', extra_charges: [], unit_name: 'A1', is_frozen: false }], error: null });

    const req = mockReq({ body: { name: 'Water', amount: 500, scope: 'units', unitIds: ['U1', 'U9'] } });
    const res = mockRes();
    await addExtraCharge(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/do not belong to this property/) }));
  });

  test("scope 'unit' (default): a frozen primary unit is blocked outright, not silently skipped", async () => {
    const primaryUnit = { extra_charges: [], unit_name: 'A1', property_id: 'P1', landlord_id: 'L1', is_frozen: true };
    setupSupabaseMock(supabase, { units: { data: primaryUnit, error: null } });

    const req = mockReq({ body: { name: 'Water', amount: 500, scope: 'unit' } });
    const res = mockRes();
    await addExtraCharge(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/frozen/) }));
  });

  test("recurring charge tops up an already-billed tenant's balance_due immediately", async () => {
    const primaryUnit = { extra_charges: [], unit_name: 'A1', property_id: null, landlord_id: 'L1', is_frozen: false };
    const builders = setupSupabaseMock(supabase, {
      units: { data: primaryUnit, error: null },
      tenants: { data: { id: 'T1', balance_due: 5000, last_billed_period: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}` }, error: null },
    });

    const req = mockReq({ body: { name: 'Garbage', amount: 300, recurring: true, scope: 'unit' } });
    const res = mockRes();
    await addExtraCharge(req, res);

    expect(builders.tenants.update).toHaveBeenCalledWith({ balance_due: 5300 });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});
