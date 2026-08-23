// src/utils/unitCode.js
//
// Generates the permanent Unit Code described in blueprint 4.2:
//   Format: RPA-[UnitName]-[Number]
//   e.g. RPA-A1-001
//
// The code is tied to the physical unit, not the tenant, so it never
// changes even when tenants come and go.

const supabase = require('../config/supabase');

/**
 * Generates the next unit code for a landlord.
 * Number increments globally per landlord (001, 002, 003...) regardless
 * of unit name, matching the blueprint's example table (4.2).
 */
async function generateUnitCode(landlordId, unitName) {
  // FIX (duplicate key on units_unit_payment_code_key): this used to
  // number units by a live `count(*)` of a landlord's units. That
  // breaks the moment any unit is ever deleted - the count drops back
  // down, but the sequence numbers already used (001, 002, ...) are
  // still taken, so the "next" number collides with an existing code
  // the very next time a unit is created. Instead we look at the
  // highest sequence number actually in use (including ones whose
  // unit was later deleted) and always count up from there, so a
  // number is never reused.
  const { data: rows, error } = await supabase
    .from('units')
    .select('unit_payment_code')
    .eq('landlord_id', landlordId)
    .not('unit_payment_code', 'is', null);

  if (error) throw new Error(`Failed to look up existing unit codes: ${error.message}`);

  let maxNumber = 0;
  for (const row of rows || []) {
    const match = /-(\d{3,})$/.exec(row.unit_payment_code || '');
    if (match) maxNumber = Math.max(maxNumber, parseInt(match[1], 10));
  }

  const cleanUnitName = unitName.replace(/\s+/g, '').toUpperCase();

  // Guard against a rare race (two units created at the same instant)
  // by retrying on a unique-constraint violation with the next number,
  // instead of just failing the request.
  //
  // FIX: this existence check used to be unscoped (checked ANY
  // landlord's units for the candidate code), which relied on
  // unit_payment_code being globally unique in the database. That
  // constraint was wrong - see sql/2026-08-fix-unit-payment-code-scope.sql
  // - and codes are built from the landlord's own literal unit name
  // (e.g. "A1" -> "RPA-A1-001"), so two different landlords who both
  // name a unit "A1" always produced the identical code. Scoping this
  // check to landlord_id (matching the DB constraint and matching
  // maxNumber above, which was already landlord-scoped) means a
  // collision can now only happen against this SAME landlord's own
  // units - a genuine, retryable race - instead of a permanent clash
  // with a complete stranger's property that no amount of retrying
  // could ever resolve.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidateNumber = maxNumber + 1 + attempt;
    const candidateCode = `RPA-${cleanUnitName}-${String(candidateNumber).padStart(3, '0')}`;
    const { data: existing } = await supabase
      .from('units')
      .select('id')
      .eq('landlord_id', landlordId)
      .eq('unit_payment_code', candidateCode)
      .maybeSingle();
    if (!existing) return candidateCode;
  }

  // Extremely unlikely fallback: timestamp-suffixed code, still unique.
  return `RPA-${cleanUnitName}-${Date.now().toString().slice(-6)}`;
}

/**
 * Rebuilds a unit's code when its unit_name changes, keeping
 * the same sequence number (the part of the blueprint 4.2 format that
 * must never change, since it's what ties historical payments/receipts
 * together) but swapping in the new name - e.g. renaming "A1" to "A1B"
 * turns RPA-A1-001 into RPA-A1B-001, not a brand new number.
 *
 * Falls back to "001" (rather than throwing) if the old code doesn't
 * match the expected format - can happen for very old/hand-edited
 * rows, and it's better to produce a still-valid code than to block
 * the rename entirely.
 */
function regenerateUnitCode(oldCode, newUnitName) {
  const cleanUnitName = newUnitName.replace(/\s+/g, '').toUpperCase();
  const match = /^RPA-.+-(\d{3,})$/.exec(oldCode || '');
  const number = match ? match[1] : '001';
  return `RPA-${cleanUnitName}-${number}`;
}

/**
 * Escapes Postgres ILIKE wildcard characters (% and _) plus the
 * backslash escape character itself, so a unit name typed by a
 * landlord is matched LITERALLY (case-insensitively) rather than as a
 * pattern. Without this, a name containing "_" or "%" (e.g.
 * "Block_A1") silently matches OTHER unit names too - causing false
 * "a unit with this name already exists" clashes on create/rename, or
 * missed clashes, depending on what else happens to exist. This bug
 * is what made renames look like they "didn't take" - the request was
 * being rejected (or mismatched) by this check before ever reaching
 * the actual update.
 */
function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

module.exports = { generateUnitCode, regenerateUnitCode, escapeLikePattern };
