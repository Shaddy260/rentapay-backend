-- =====================================================================
-- FEATURE (direct request): a PROPERTY reputation, separate from the
-- existing landlord / manager / caretaker reputations. Sits right
-- alongside those other rating widgets in the tenant portal ("beside
-- the existing reputations"), but with three deliberate differences:
--
--   1. It is rated by CURRENT TENANTS of that property (any active
--      tenant whose unit belongs to the property), not by one
--      tenant about one specific staff member.
--   2. It is the ONLY reputation ever shown on a PUBLIC page - the
--      vacant-units listing. Landlord/manager/caretaker reputations
--      stay exactly as they are today: visible only inside the
--      authenticated portals, never on the public listings page.
--   3. Like landlord/staff reputation, it is aggregate-only in any
--      response that could leak who-said-what about a place someone
--      still lives - never a single review tied to an identifiable
--      tenant.
--
-- Run this in the Supabase SQL Editor after schema.sql and
-- add-tenant-security-deposit.sql.
-- =====================================================================

create table if not exists property_ratings (
  id uuid primary key default gen_random_uuid(),

  property_id uuid not null references properties(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,

  -- Kept for traceability ("rated while living in Unit X") but NOT the
  -- aggregation key, same reasoning as tenant_ratings.tenant_id - the
  -- rating must keep counting even after this specific tenant_id is
  -- archived/deleted, as long as the property itself still exists.
  tenant_id uuid references tenants(id) on delete set null,
  unit_id uuid references units(id) on delete set null,

  rating int not null check (rating between 1 and 5),
  category text not null default 'overall'
    check (category in ('overall', 'safety', 'maintenance', 'noise', 'water_electricity', 'value_for_money')),
  comment text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_property_ratings_property on property_ratings(property_id);
create index if not exists idx_property_ratings_landlord on property_ratings(landlord_id);
create index if not exists idx_property_ratings_tenant on property_ratings(tenant_id);

-- One active rating per tenant+property+category - a tenant updating
-- their rating replaces it rather than stacking duplicates, same
-- pattern as tenant_ratings/landlord_ratings/staff_ratings.
create unique index if not exists uq_property_rating_tenant_category
  on property_ratings(tenant_id, property_id, category);

-- =====================================================================
-- FEATURE (direct request): a landlord (or manager/caretaker) explicitly
-- confirms a vacant unit's listing status - "still active", "already
-- booked" (someone has committed but hasn't moved in/been marked
-- occupied yet), or "planned for" (earmarked, not really open to new
-- inquiries right now). This is DELIBERATELY separate from:
--   - units.status (occupied/notice_given/vacant/maintenance) - the
--     actual occupancy state, changed when a tenant is added/removed.
--   - units.last_verified_at - a simple "yes, still vacant" timestamp
--     ping (see add-scout-referrals.sql / "Still vacant - confirm").
--
-- listing_status only matters while units.status = 'vacant'; the
-- moment a tenant is filled in and units.status flips to 'occupied',
-- the unit already drops out of the public/vacant listing regardless
-- of listing_status (see public.controller.js's hard status='vacant'
-- filter) - so listing_status doesn't need its own cleanup on
-- occupancy, it simply stops being read.
-- =====================================================================

alter table units add column if not exists listing_status text not null default 'active'
  check (listing_status in ('active', 'booked', 'planned'));
alter table units add column if not exists listing_status_updated_at timestamptz;
alter table units add column if not exists listing_status_updated_by_type text
  check (listing_status_updated_by_type in ('landlord', 'manager', 'caretaker', 'admin'));

-- If this migration already ran before 'admin' was added to the list above,
-- widen the existing constraint so admin-confirmed status changes aren't
-- silently mislabeled as landlord-confirmed:
-- alter table units drop constraint if exists units_listing_status_updated_by_type_check;
-- alter table units add constraint units_listing_status_updated_by_type_check
--   check (listing_status_updated_by_type in ('landlord', 'manager', 'caretaker', 'admin'));
alter table units add column if not exists listing_status_updated_by_id uuid;

create index if not exists idx_units_listing_status on units(status, listing_status);

-- =====================================================================
-- FEATURE (direct request): show whether a unit requires a deposit at
-- all, in the vacant-unit listing - purely a landlord-set flag on the
-- UNIT itself (what's asked of any FUTURE tenant), distinct from
-- tenants.deposit_amount/deposit_status in add-tenant-security-deposit.sql
-- (what was actually collected from a tenant already living there).
-- Defaults to false so existing units read as "no deposit" until a
-- landlord explicitly says otherwise; deposit_amount_expected is
-- optional context (e.g. "1 month's rent") shown alongside the flag.
-- =====================================================================

alter table units add column if not exists requires_deposit boolean not null default false;
alter table units add column if not exists deposit_amount_expected numeric(12,2);

-- =====================================================================
-- VERIFICATION:
--   select table_name from information_schema.tables where table_name = 'property_ratings';
--   select column_name from information_schema.columns where table_name = 'units'
--     and column_name in ('listing_status','listing_status_updated_at','listing_status_updated_by_type',
--                          'listing_status_updated_by_id','requires_deposit','deposit_amount_expected');
-- =====================================================================
