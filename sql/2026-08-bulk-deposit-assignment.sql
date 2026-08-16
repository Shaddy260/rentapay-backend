-- ---------------------------------------------------------------------
-- Landlord Bulk Deposit Assignment
-- ---------------------------------------------------------------------
-- No new columns are required for this feature: units.requires_deposit
-- and units.deposit_amount_expected already exist (see
-- 2026-07-property-reputation-listing-status-deposit.sql) and are
-- reused as-is by the new bulk endpoint (POST /units/bulk-deposit-
-- settings). This file only adds an index to support the new query
-- pattern the bulk endpoint introduces: fetching every unit for a
-- landlord (optionally narrowed to one property) to apply one deposit
-- rule across the whole portfolio in a single request.
--
-- Safe to run multiple times (IF NOT EXISTS) and safe to run on a
-- database that already has the deposit columns from the July 2026
-- migration.
-- ---------------------------------------------------------------------

create index if not exists idx_units_landlord_property
  on units (landlord_id, property_id);

-- Optional but useful for admin/reporting queries that filter on
-- "which units currently require a deposit" across a landlord's
-- portfolio (e.g. before/after auditing a bulk assignment).
create index if not exists idx_units_requires_deposit
  on units (landlord_id, requires_deposit);
