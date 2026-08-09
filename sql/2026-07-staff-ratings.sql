-- =====================================================================
-- Tenant -> Property Manager / Caretaker ratings (direct request #8:
-- "Tenants should be able to rate not just the Landlord, but also the
-- Property Manager and Caretaker separately - three distinct rating
-- categories"). Landlord ratings already exist (landlord_ratings,
-- see 2026-0x migration); this adds the missing manager/caretaker
-- side using the same 1-5 star + optional comment shape.
--
-- Keyed by manager_id (property_managers.id), NOT by email/phone like
-- tenant_ratings - property_managers.phone is already unique across
-- the whole table, so a given person can only ever have one
-- property_managers row on the platform. That row IS their durable
-- identity: it already follows them across every property they're
-- assigned to within their landlord account (the requirement that
-- "rating history follows them regardless of property/account
-- context" is satisfied automatically, no email-portability dance
-- needed the way tenant_ratings/landlord_ratings require).
--
-- role_level is denormalized from property_managers at rating time so
-- historical ratings stay correctly labeled even if a landlord later
-- changes someone from caretaker to full manager or vice versa.
-- =====================================================================

create table if not exists staff_ratings (
  id uuid primary key default gen_random_uuid(),

  landlord_id uuid not null references landlords(id) on delete cascade,
  manager_id uuid not null references property_managers(id) on delete cascade,
  role_level text not null check (role_level in ('manager', 'caretaker')),

  tenant_id uuid not null references tenants(id) on delete cascade,

  rating int not null check (rating between 1 and 5),
  comment text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One rating per tenant per staff member - re-rating updates the
  -- existing row (upsert), same convention as tenant_ratings/
  -- landlord_ratings' one-rating-per-relationship rule.
  unique (tenant_id, manager_id)
);

create index if not exists idx_staff_ratings_manager on staff_ratings(manager_id);

drop trigger if exists trg_staff_ratings_updated_at on staff_ratings;
create trigger trg_staff_ratings_updated_at before update on staff_ratings
  for each row execute function set_updated_at();

-- VERIFICATION:
--   select * from staff_ratings limit 1;
-- =====================================================================
