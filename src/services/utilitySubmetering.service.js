// src/services/utilitySubmetering.service.js
//
// Utility Sub-Metering - see RentaPay-Utility-Submetering-Spec.pdf.
// Owns the calculation logic for Sections 2-5 (baseline, usage,
// occupied-day split) and the shared read helpers the controller uses
// for Sections 6-7 (review + finalize). Anything that's a pure DB
// read/write with no calculation lives in the controller instead.

const supabase = require('../config/supabase');

// ---------------------------------------------------------------------
// Section 3 - anomaly detection. Compares a new reading's implied usage
// against the meter's recent history. Flags, never blocks (Section 3:
// "This does not block the submission outright; it flags it").
// ---------------------------------------------------------------------
const ANOMALY_SPIKE_MULTIPLIER = 2.5; // usage more than 2.5x the recent average

async function detectAnomaly(meterId, usage) {
  if (usage < 0) {
    return { anomaly: true, reason: 'New reading is lower than the previous reading - unusual for a rotary meter. Please double-check.' };
  }

  const { data: recent } = await supabase
    .from('utility_readings')
    .select('usage_amount')
    .eq('meter_id', meterId)
    .not('usage_amount', 'is', null)
    .order('month_key', { ascending: false })
    .limit(6);

  const history = (recent || []).map((r) => Number(r.usage_amount)).filter((v) => v > 0);
  if (history.length < 2) return { anomaly: false, reason: null }; // not enough history to judge a spike yet

  const avg = history.reduce((a, b) => a + b, 0) / history.length;
  if (avg > 0 && usage > avg * ANOMALY_SPIKE_MULTIPLIER) {
    return {
      anomaly: true,
      reason: `This reading implies ${Math.round(usage)} units used - a large spike compared to this meter's recent average of ~${Math.round(avg)} units/month. Please double-check the number before continuing.`,
    };
  }
  return { anomaly: false, reason: null };
}

// ---------------------------------------------------------------------
// Section 2 - find the reading immediately before the given month for
// this meter (baseline included), which becomes "previous reading" for
// the usage formula.
// ---------------------------------------------------------------------
async function getPreviousReading(meterId, monthKey) {
  const { data, error } = await supabase
    .from('utility_readings')
    .select('*')
    .eq('meter_id', meterId)
    .lt('month_key', monthKey)
    .order('month_key', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ---------------------------------------------------------------------
// Section 4 - occupied-days for a unit within a given calendar month,
// derived from that unit's active tenancy's actual move-in/move-out
// dates on file (the default source of truth per the spec).
// ---------------------------------------------------------------------
function daysInMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month, 0).getDate();
}

// One calendar month before the given YYYY-MM key. Used to give a
// first-ever "previous reading" a month_key that sorts before the
// tenant's actual first billed month, so getPreviousReading() picks
// it up via its existing "< monthKey" lookup with no special-casing.
function decrementMonthKey(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

function occupiedDaysForTenancy(monthKey, moveInDate, moveOutDate) {
  const [year, month] = monthKey.split('-').map(Number);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month - 1, daysInMonth(monthKey)));

  const moveIn = moveInDate ? new Date(moveInDate) : monthStart;
  const moveOut = moveOutDate ? new Date(moveOutDate) : monthEnd;

  const effectiveStart = moveIn > monthStart ? moveIn : monthStart;
  const effectiveEnd = moveOut < monthEnd ? moveOut : monthEnd;

  if (effectiveEnd < effectiveStart) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((effectiveEnd - effectiveStart) / msPerDay) + 1;
}

// Section 4's "Done when": for a shared meter, identify occupied units
// and each one's occupied-days for the given month automatically.
async function getOccupiedUnitsForMonth(meterId, monthKey) {
  const { data: meterUnits, error } = await supabase
    .from('utility_meter_units')
    .select('unit_id, units(id, unit_name)')
    .eq('meter_id', meterId);
  if (error) throw error;
  if (!meterUnits || meterUnits.length === 0) return [];

  const unitIds = meterUnits.map((mu) => mu.unit_id);

  // A unit counts as occupied that month if it has a tenancy overlapping
  // the month at all (current active tenant, or one who moved out mid-
  // month, or one who moved in mid-month) - `tenants` carries the
  // move-in/move-out dates already on file, same source of truth used
  // elsewhere in the app for occupancy.
  const { data: tenancies, error: tenErr } = await supabase
    .from('tenants')
    .select('unit_id, move_in_date, left_at, is_active')
    .in('unit_id', unitIds);
  if (tenErr) throw tenErr;

  const results = [];
  for (const mu of meterUnits) {
    const tenancy = (tenancies || [])
      .filter((t) => t.unit_id === mu.unit_id)
      // Prefer the currently-active tenancy; fall back to the most
      // recent one that overlaps the month if the unit turned over.
      .sort((a, b) => (b.is_active === true) - (a.is_active === true))[0];

    if (!tenancy) continue; // never occupied - excluded entirely, per spec

    const occupiedDays = occupiedDaysForTenancy(monthKey, tenancy.move_in_date, tenancy.left_at);
    if (occupiedDays <= 0) continue; // vacant that month - excluded, not counted in the divisor

    results.push({
      unitId: mu.unit_id,
      unitName: mu.units?.unit_name || null,
      occupiedDays,
    });
  }
  return results;
}

// ---------------------------------------------------------------------
// Section 5 - proportional split across occupied units for a shared
// meter. Pure function so the review screen's live recalculation
// (Section 6) can call this again with overridden occupied-days
// without touching the DB.
// ---------------------------------------------------------------------
function splitSharedUsage(totalUsage, ratePerUnit, occupiedUnits) {
  const totalOccupiedDays = occupiedUnits.reduce((sum, u) => sum + Number(u.occupiedDays), 0);
  if (totalOccupiedDays <= 0) {
    return occupiedUnits.map((u) => ({ ...u, shareOfUsage: 0, amount: 0 }));
  }
  return occupiedUnits.map((u) => {
    const shareOfUsage = (Number(u.occupiedDays) / totalOccupiedDays) * totalUsage;
    const amount = Math.round(shareOfUsage * ratePerUnit * 100) / 100;
    return { ...u, shareOfUsage, amount };
  });
}

// Section 3 - single-unit (non-shared) usage + amount.
function calculateIndividualUsage(newReading, previousReading, ratePerUnit) {
  const usage = Number(newReading) - Number(previousReading);
  const amount = Math.round(usage * ratePerUnit * 100) / 100;
  return { usage, amount };
}

module.exports = {
  detectAnomaly,
  getPreviousReading,
  daysInMonth,
  decrementMonthKey,
  occupiedDaysForTenancy,
  getOccupiedUnitsForMonth,
  splitSharedUsage,
  calculateIndividualUsage,
};
