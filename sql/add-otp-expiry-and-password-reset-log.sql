-- =====================================================================
-- Direct request (follow-up to add-first-time-credentials.sql):
-- "landlords receive OTPs too, for password resets - those should be
-- stored to the admin portal same as first-time credentials, arranged
-- by category. ALL of these (first_time_credentials, this new table,
-- AND the real otp_code columns on the account tables) should expire
-- and be DELETED the moment their expiry time is reached - not just
-- treated as invalid."
--
-- Two changes:
--
-- 1) first_time_credentials gets an expires_at column. It never had
--    an expiry concept before (blueprint 13.x treated it as valid
--    until the person's first login), but it's added here at a
--    generous 14 days so old temp-password rows don't pile up
--    forever - by day 14 the person has either logged in already
--    (which forces a real password via must_change_password) or the
--    account was a dead end anyway.
--
-- 2) password_reset_requests: a NEW table, deliberately separate from
--    first_time_credentials rather than folding into it - the two
--    represent different moments (account creation vs. an existing
--    account being recovered) and first_time_credentials.role's check
--    constraint intentionally excludes 'landlord' since landlords
--    never got a first-time temp password. Landlords DO request
--    password resets like anyone else, so this table's role list
--    includes 'landlord' where the other table's does not.
-- =====================================================================

alter table first_time_credentials
  add column if not exists expires_at timestamptz not null default (now() + interval '14 days');

create table if not exists password_reset_requests (
  id uuid primary key default gen_random_uuid(),
  -- null for a landlord's own reset request (there's no "owning"
  -- landlord above a landlord) - populated for tenant/manager/caretaker
  -- so the landlord portal can filter to just their own people.
  landlord_id uuid references landlords(id) on delete cascade,
  role text not null check (role in ('landlord', 'tenant', 'manager', 'caretaker')),
  account_id uuid not null, -- the landlords.id / tenants.id / property_managers.id row
  full_name text not null,
  phone text not null,
  otp text not null,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_password_reset_requests_landlord on password_reset_requests(landlord_id, role);
create index if not exists idx_password_reset_requests_expiry on password_reset_requests(expires_at);
create index if not exists idx_first_time_credentials_expiry on first_time_credentials(expires_at);
