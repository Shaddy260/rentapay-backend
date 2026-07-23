-- =====================================================================
-- Property Managers (second-party portal access) + Caretaker fields
-- + Scheduled rent changes with an effective date.
-- Run this in the Supabase SQL Editor AFTER schema.sql and the other
-- migrations in this folder.
-- =====================================================================

-- ---------------------------------------------------------------------
-- CARETAKER fields on properties - separate from the property manager,
-- who is now a real login account (see below). Caretaker is just a
-- contact record, editable any time, no login.
-- ---------------------------------------------------------------------
alter table properties add column if not exists caretaker_name text;
alter table properties add column if not exists caretaker_phone text;

-- The old manager_name / manager_phone free-text columns are kept
-- (nothing is deleted per project convention) but are no longer read
-- or written by the app - the property_managers table below is now
-- the source of truth for "who is the property manager".

-- ---------------------------------------------------------------------
-- PROPERTY MANAGERS  (second-party accounts, added by a landlord,
-- log in with their own credentials, see the same portal as the
-- landlord but with some actions locked - see auth.middleware.js)
-- ---------------------------------------------------------------------
create table if not exists property_managers (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,

  full_name text not null,
  phone text not null unique,
  email text,
  photo_url text,
  password_hash text not null,

  otp_code text,
  otp_expires_at timestamptz,
  is_verified boolean default false,
  must_change_password boolean default true,

  is_active boolean default true, -- landlord can deactivate without deleting

  failed_login_attempts int default 0,
  locked_until timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_property_managers_landlord on property_managers(landlord_id);
create index if not exists idx_property_managers_phone on property_managers(phone);

drop trigger if exists trg_property_managers_updated_at on property_managers;
create trigger trg_property_managers_updated_at before update on property_managers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- PROPERTY MANAGER ASSIGNMENTS  (which properties a given manager may
-- actually manage - many-to-many so a landlord with several
-- properties can either give one manager all of them or split access
-- per property). A manager still SEES every property belonging to
-- their landlord in listings; opening one they're not assigned to
-- is blocked at the API level with a clear "not authorized" message
-- rather than being hidden, per the landlord's request.
-- ---------------------------------------------------------------------
create table if not exists property_manager_assignments (
  id uuid primary key default gen_random_uuid(),
  property_manager_id uuid not null references property_managers(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  created_at timestamptz default now(),
  unique (property_manager_id, property_id)
);

create index if not exists idx_pm_assignments_manager on property_manager_assignments(property_manager_id);
create index if not exists idx_pm_assignments_property on property_manager_assignments(property_id);

-- ---------------------------------------------------------------------
-- SCHEDULED RENT CHANGES  (blueprint addition: changing a unit's rent
-- now requires an effective date - immediately, next billing month,
-- or a specific future date - instead of overwriting rent_amount on
-- the spot).
-- ---------------------------------------------------------------------
create table if not exists rent_changes (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,

  old_amount numeric(12,2) not null,
  new_amount numeric(12,2) not null,
  effective_date date not null,

  status text check (status in ('pending', 'applied', 'cancelled')) default 'pending',

  created_by_type text check (created_by_type in ('landlord', 'manager')) not null,
  created_by_id uuid not null,

  applied_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_rent_changes_unit on rent_changes(unit_id);
create index if not exists idx_rent_changes_status on rent_changes(status);

-- ---------------------------------------------------------------------
-- CONTACT DETAILS shown to tenants: rather than every tenant screen
-- reading landlords.phone directly (which breaks the "show the
-- property manager's contact instead, when one is assigned" rule),
-- units gain an optional pointer to which property_manager currently
-- "owns" tenant-facing contact info for that unit's property. Null =
-- fall back to the landlord's own contact details.
-- ---------------------------------------------------------------------
alter table properties add column if not exists primary_contact_manager_id uuid references property_managers(id) on delete set null;
