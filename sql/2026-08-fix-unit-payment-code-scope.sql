-- =====================================================================
-- FIX: unit_payment_code was declared globally unique across ALL
-- landlords (schema.sql line ~88: "unit_payment_code text not null
-- unique"), but the code is built from the literal unit name typed by
-- the landlord (e.g. "A1" -> "RPA-A1-001"). Unit names like "A1",
-- "B2", "House 1" are extremely common across different landlords'
-- properties, so two unrelated landlords naming a unit the same thing
-- generate the IDENTICAL code and the database permanently rejects
-- the second one - not a timing/race issue, so retrying never helps.
--
-- Every other check in the app (name-uniqueness, sequence numbering)
-- already scopes correctly by landlord_id. This migration brings the
-- actual database constraint in line with that: unit codes only need
-- to be unique WITHIN a landlord's own units, not across the whole
-- platform.
--
-- Run this in the Supabase SQL Editor.
-- =====================================================================

-- Drop the old global-uniqueness constraint (name may vary slightly by
-- environment - this is Postgres's default auto-generated name for a
-- column-level `unique` on units.unit_payment_code).
alter table units drop constraint if exists units_unit_payment_code_key;

-- Add the correctly-scoped composite constraint instead: a code must
-- be unique per landlord, not across the whole table.
alter table units
  add constraint units_landlord_id_unit_payment_code_key
  unique (landlord_id, unit_payment_code);
