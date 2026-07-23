-- =====================================================================
-- RentaPay Database Schema
-- Run this in the Supabase SQL Editor (Project > SQL Editor > New Query)
-- Matches blueprint sections 2 (User Hierarchy), 3-9, 14 (Security)
-- =====================================================================

-- Needed for gen_random_uuid()
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- LANDLORDS
-- ---------------------------------------------------------------------
create table landlords (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null unique,
  email text unique,
  photo_url text, -- profile picture URL; actual upload mechanism built separately (shared with tenants)
  password_hash text not null,

  -- Setup wizard / property info (blueprint 3.2)
  estate_name text,
  location text,
  county text,
  description text,

  -- Payment method landlord receives rent through (blueprint 3.2 step 2)
  payment_method text check (payment_method in ('paybill', 'till', 'stk')) default 'stk',
  paybill_number text,
  paybill_account_number text,
  till_number text,

  -- Subscription (blueprint section 9)
  subscription_plan text check (subscription_plan in ('starter', 'standard', 'premium')) default 'starter',
  subscription_period_months int default 1,
  subscription_status text check (subscription_status in ('pending', 'active', 'warning', 'suspended')) default 'pending',
  subscription_started_at timestamptz,
  subscription_expires_at timestamptz,
  unit_limit int default 0, -- how many units they've paid for

  -- Onboarding / verification
  otp_code text,
  otp_expires_at timestamptz,
  is_verified boolean default false,
  setup_wizard_complete boolean default false,
  must_change_password boolean default false, -- landlords normally set their own password at signup, but this mirrors tenants' column so changePassword() can treat both roles uniformly (e.g. a landlord reset by admin)

  -- Security (blueprint 14)
  failed_login_attempts int default 0,
  locked_until timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- PROPERTIES  (optional grouping for landlords with more than one
-- rental property/location - see sql/2026-07-fixes.sql for the full
-- rationale and the multi-property design notes)
-- ---------------------------------------------------------------------
create table properties (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,

  name text not null,
  location text,
  county text,
  description text,

  manager_name text,
  manager_phone text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_properties_landlord on properties(landlord_id);

-- ---------------------------------------------------------------------
-- UNITS  (belongs to a landlord)
-- ---------------------------------------------------------------------
create table units (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid references properties(id) on delete set null, -- optional grouping; null = ungrouped/default

  unit_name text not null,         -- e.g. "A1"
  unit_payment_code text not null unique, -- e.g. "RPA-A1-001" (blueprint 4.2)
  unit_type text,                  -- e.g. "Bedsitter", "1 Bedroom"

  rent_amount numeric(12,2) not null,
  due_day_of_month int default 1 check (due_day_of_month between 1 and 28),

  -- Extra charges (blueprint 6.1) stored as jsonb so landlords can add custom ones
  -- e.g. [{"name": "Water", "amount": 500}, {"name": "Garbage", "amount": 200}]
  extra_charges jsonb default '[]'::jsonb,

  status text check (status in ('occupied', 'notice_given', 'vacant', 'maintenance')) default 'vacant',

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_units_landlord on units(landlord_id);
create index idx_units_property on units(property_id);

-- ---------------------------------------------------------------------
-- TENANTS  (belongs to a unit + landlord)
-- ---------------------------------------------------------------------
create table tenants (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,

  full_name text not null,
  primary_phone text not null,
  secondary_phone text,
  email text,
  photo_url text, -- profile picture URL; same mechanism as landlords' photo_url
  id_number text not null,

  move_in_date date not null,
  rent_override numeric(12,2), -- if set, overrides unit's default rent for this tenant
  due_day_of_month int,        -- if set, overrides unit's default due day

  emergency_contact_name text not null,
  emergency_contact_phone text not null,

  password_hash text,
  otp_code text,
  otp_expires_at timestamptz,
  is_verified boolean default false,
  must_change_password boolean default true,

  -- Balance tracking (blueprint 6)
  balance_due numeric(12,2) default 0,
  interest_accrued numeric(12,2) default 0,
  interest_waived boolean default false,

  -- Prepayment / credit tracking - NOT in the original blueprint
  -- (blueprint section 6 only describes arrears/underpayment, never
  -- overpayment). Added by direct request: when a tenant pays more
  -- than the current amount due, paid_through_date advances forward
  -- by however many full months the excess covers, so the portal can
  -- say "paid through 15 Nov" / "next payment due in ~165 days"
  -- instead of overpayment silently vanishing or sitting as an
  -- ambiguous balance number.
  paid_through_date date,

  -- Vacating notice (blueprint 8)
  notice_given boolean default false,
  notice_date date,            -- intended vacating date
  notice_reason text,
  notice_submitted_at timestamptz,

  is_active boolean default true, -- false once vacated/archived

  failed_login_attempts int default 0,
  locked_until timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_tenants_landlord on tenants(landlord_id);
create index idx_tenants_unit on tenants(unit_id);
create index idx_tenants_phone on tenants(primary_phone);

-- ---------------------------------------------------------------------
-- PAYMENTS  (rent payments from tenants)
-- ---------------------------------------------------------------------
create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,

  amount numeric(12,2) not null,
  payment_method text check (payment_method in ('stk_push', 'paybill', 'manual')) not null,

  mpesa_transaction_id text,   -- Daraja receipt number
  mpesa_phone text,
  mpesa_checkout_request_id text, -- for STK push tracking before confirmation

  status text check (status in ('pending', 'completed', 'failed', 'rejected')) default 'pending',
  is_partial boolean default false,

  -- For manually recorded payments (blueprint 5.6)
  recorded_by_landlord boolean default false,
  recorded_note text,
  paid_by text, -- 'self' or 'third_party'

  paid_at timestamptz,
  created_at timestamptz default now()
);

create index idx_payments_tenant on payments(tenant_id);
create index idx_payments_landlord on payments(landlord_id);
create index idx_payments_mpesa_trans on payments(mpesa_transaction_id);

-- ---------------------------------------------------------------------
-- SUBSCRIPTION PAYMENTS  (landlord paying RentaPay, separate from rent)
-- ---------------------------------------------------------------------
create table subscription_payments (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,

  plan text check (plan in ('starter', 'standard', 'premium')) not null,
  period_months int not null,
  units_count int not null,
  amount numeric(12,2) not null,

  mpesa_transaction_id text,
  mpesa_phone text,
  mpesa_checkout_request_id text,

  status text check (status in ('pending', 'completed', 'failed')) default 'pending',

  paid_at timestamptz,
  created_at timestamptz default now()
);

create index idx_sub_payments_landlord on subscription_payments(landlord_id);

-- ---------------------------------------------------------------------
-- ACTIVITY LOG  (blueprint 14.2 - every action, who/what/when/IP)
-- ---------------------------------------------------------------------
create table activity_logs (
  id uuid primary key default gen_random_uuid(),

  actor_type text check (actor_type in ('admin', 'landlord', 'tenant', 'system')) not null,
  actor_id uuid, -- null for system actions
  action text not null,        -- e.g. "waived_interest", "revoked_notice"
  target_type text,            -- e.g. "tenant", "unit", "landlord"
  target_id uuid,
  reason text,
  ip_address text,
  metadata jsonb default '{}'::jsonb,

  created_at timestamptz default now()
);

create index idx_activity_logs_actor on activity_logs(actor_type, actor_id);
create index idx_activity_logs_target on activity_logs(target_type, target_id);

-- ---------------------------------------------------------------------
-- HELP REQUESTS  (blueprint 15)
-- ---------------------------------------------------------------------
create table help_requests (
  id uuid primary key default gen_random_uuid(),

  -- 'guest' added for pre-login help requests submitted from the Login
  -- page (blueprint 15: "help before logging in") - requester_id is
  -- null in that case since there's no account yet.
  requester_type text check (requester_type in ('landlord', 'tenant', 'guest')) not null,
  requester_id uuid,
  name text not null,
  phone text,
  message text not null,
  screenshot_url text,

  status text check (status in ('open', 'resolved')) default 'open',
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Helper: auto-update updated_at columns
-- ---------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_landlords_updated_at before update on landlords
  for each row execute function set_updated_at();

create trigger trg_units_updated_at before update on units
  for each row execute function set_updated_at();

create trigger trg_tenants_updated_at before update on tenants
  for each row execute function set_updated_at();

create trigger trg_properties_updated_at before update on properties
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- PLATFORM SETTINGS - single-row table for platform-wide state.
-- NOT in the original blueprint as a literal table, but required to
-- make emergency lockdown (13.2) actually function: previously
-- "lockdown" only flipped each landlord's subscription_status, which
-- login() never even checks - tenants and admin were completely
-- unaffected, so the platform kept working normally during a
-- "lockdown." This table gives login() something real to check for
-- every account type.
-- ---------------------------------------------------------------------
create table platform_settings (
  id int primary key default 1,
  is_locked_down boolean default false,
  lockdown_reason text,
  lockdown_started_at timestamptz,
  constraint single_row check (id = 1)
);

insert into platform_settings (id, is_locked_down) values (1, false);
