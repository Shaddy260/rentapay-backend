-- =====================================================================
-- Migration: 2026-07 fixes (run this once in Supabase SQL Editor)
-- =====================================================================
-- Safe to run even if some of these already exist / are already
-- correct - everything below uses "if not exists" / idempotent
-- updates. This single script brings your live database in sync with
-- the current schema.sql, regardless of which earlier sql/*.sql files
-- you already ran.
--
-- WHAT THIS FIXES:
--
-- 1. "Could not find the 'must_change_password' column of 'landlords'
--    in the schema cache" - the changePassword endpoint tried to write
--    this column for BOTH landlords and tenants, but it only ever
--    existed on tenants. Every landlord password change (forced or
--    voluntary) was failing.
--
-- 2. Phone numbers stored inconsistently (some as "0712345678", some
--    as "254712345678") - the root cause behind "no matching account
--    found", the onboarding loop, and "invalid code" on forgot-
--    password for anyone who typed their number differently at
--    different points. The backend now normalizes every phone number
--    going forward (see src/utils/phone.js) - this migration
--    normalizes what's already stored so existing accounts are fixed
--    retroactively too.
--
-- 3. Adds `properties` + a manager contact, for landlords who run more
--    than one rental property (see the "multi-property" section
--    below and PROPERTIES_AND_MULTI_LOCATION.md for the full design).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. must_change_password on landlords
-- ---------------------------------------------------------------------
alter table landlords add column if not exists must_change_password boolean default false;

-- ---------------------------------------------------------------------
-- 2. Normalize existing phone numbers to 2547XXXXXXXX / 2541XXXXXXXX
-- ---------------------------------------------------------------------
-- Strips spaces/dashes, then rewrites leading "0" or "+254" to "254".
-- Numbers that don't match a recognizable Kenyan shape are left
-- untouched (regex guards against mangling already-correct or
-- genuinely invalid data) - check the two "still not normalized"
-- SELECTs at the bottom afterward and fix any stragglers by hand.

update landlords
set phone = '254' || regexp_replace(phone, '^(?:\+?254|0)', '')
where phone ~ '^0[17][0-9]{8}$' or phone ~ '^\+?254[17][0-9]{8}$';

update tenants
set primary_phone = '254' || regexp_replace(primary_phone, '^(?:\+?254|0)', '')
where primary_phone ~ '^0[17][0-9]{8}$' or primary_phone ~ '^\+?254[17][0-9]{8}$';

update tenants
set secondary_phone = '254' || regexp_replace(secondary_phone, '^(?:\+?254|0)', '')
where secondary_phone is not null
  and (secondary_phone ~ '^0[17][0-9]{8}$' or secondary_phone ~ '^\+?254[17][0-9]{8}$');

update tenants
set emergency_contact_phone = '254' || regexp_replace(emergency_contact_phone, '^(?:\+?254|0)', '')
where emergency_contact_phone ~ '^0[17][0-9]{8}$' or emergency_contact_phone ~ '^\+?254[17][0-9]{8}$';

-- Run these two after the updates above - anything they return is a
-- number this script couldn't confidently normalize (typo, landline,
-- foreign number, etc.) and needs a manual look:
--   select id, full_name, phone from landlords where phone !~ '^254[17][0-9]{8}$';
--   select id, full_name, primary_phone from tenants where primary_phone !~ '^254[17][0-9]{8}$';

-- ---------------------------------------------------------------------
-- 3. Multi-property support
-- ---------------------------------------------------------------------
-- A landlord who owns more than one rental property (different
-- estates in different locations) now gets real "properties" they can
-- switch between, instead of everything being flattened onto the one
-- estate_name/location/county on the landlords row.
--
-- Backward compatible: property_id on units is NULLABLE. Existing
-- units keep working exactly as before (ungrouped / "default
-- property"); a landlord only needs to create Property rows if they
-- actually want to split their units across locations.

create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,

  name text not null,             -- e.g. "Greenwood Apartments"
  location text,
  county text,
  description text,

  -- Optional property manager contact, shown to that property's
  -- tenants alongside the landlord's own contact (in the tenant
  -- portal + Help screen) - for landlords who have staff running a
  -- given site day-to-day.
  manager_name text,
  manager_phone text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_properties_landlord on properties(landlord_id);

alter table units add column if not exists property_id uuid references properties(id) on delete set null;
create index if not exists idx_units_property on units(property_id);

-- One-time convenience: for a landlord who already filled in
-- estate_name/location/county on their landlords row (the old single-
-- property fields), create a matching Property row and attach all of
-- their existing units to it, so they see continuity instead of an
-- empty properties list the first time they open the switcher.
-- Skips landlords who already have at least one property row (safe to
-- re-run).
insert into properties (landlord_id, name, location, county)
select l.id, coalesce(nullif(l.estate_name, ''), l.full_name || '''s property'), l.location, l.county
from landlords l
where l.estate_name is not null
  and not exists (select 1 from properties p where p.landlord_id = l.id);

update units u
set property_id = p.id
from properties p
where p.landlord_id = u.landlord_id
  and u.property_id is null
  and p.id = (select id from properties where landlord_id = u.landlord_id order by created_at asc limit 1);

drop trigger if exists trg_properties_updated_at on properties;
create trigger trg_properties_updated_at before update on properties
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 4. Help requests admin view (item F): resolved_at/resolution_note
--    for the new admin "Help Requests" tab.
-- ---------------------------------------------------------------------
alter table help_requests add column if not exists resolved_at timestamptz;
alter table help_requests add column if not exists resolution_note text;
