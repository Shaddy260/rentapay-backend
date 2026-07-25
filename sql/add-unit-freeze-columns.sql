-- =====================================================================
-- ADD: units.is_frozen / units.frozen_at
--
-- Supports "when a landlord's unit count is reduced (self-downgrade on
-- renewal, or admin adjustment) and a removed unit had a tenant, that
-- tenant goes to Archive - not deleted - and the removed unit itself
-- is greyed out / frozen (no actions can be taken on it), but keeps
-- existing in the background so it can unlock automatically the
-- moment the landlord renews/upgrades back up to (or past) that unit
-- count again." See src/utils/unitLimitEnforcement.js for the logic
-- that sets/clears these.
-- =====================================================================

alter table units add column if not exists is_frozen boolean not null default false;
alter table units add column if not exists frozen_at timestamptz;

create index if not exists idx_units_landlord_frozen on units(landlord_id, is_frozen);
