-- =====================================================================
-- Direct request: "when a landlord or manager is adding a tenant, the
-- details might not be sent - so there should be a table in menu that
-- stores those first-time accounts... stores the unit number, the
-- tenant details and the otp and temp password... during creation of
-- accts only. Should also store for caretakers in both managers and
-- landlords portal - but the landlord's portal should store for
-- manager, caretaker and tenants, in different tables based on role."
--
-- Implemented as one table with a `role` column rather than three
-- literal separate SQL tables - the landlord's menu simply shows three
-- separate filtered views (Tenants / Managers / Caretakers) over the
-- same underlying record, which gets the same result (three distinct
-- lists) without three copies of the same schema to keep in sync.
--
-- Note the real tradeoff being made here: this stores the temp
-- password in PLAIN TEXT (not hashed), which is unusual and normally
-- avoided - but the whole point of this table is to be human-readable
-- so it can be manually handed to someone whose SMS never arrived.
-- The exposure window is bounded by must_change_password already
-- forcing a real password on first login, same as it always has.
-- =====================================================================

create table if not exists first_time_credentials (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  role text not null check (role in ('tenant', 'manager', 'caretaker')),
  account_id uuid not null, -- the tenants.id or property_managers.id row this belongs to
  full_name text not null,
  phone text not null,
  unit_name text, -- tenants only; null for manager/caretaker rows
  property_name text, -- which apartment this tenant/caretaker belongs to, for context
  temp_password text not null,
  otp text not null,
  created_by_role text not null, -- 'landlord' or 'manager' - who actually created this account
  created_at timestamptz not null default now()
);

create index if not exists idx_first_time_credentials_landlord on first_time_credentials(landlord_id, role);
