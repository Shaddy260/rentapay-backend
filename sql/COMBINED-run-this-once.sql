-- =====================================================================
-- COMBINED MIGRATION - paste this ONE file, run it ONCE, in the
-- Supabase SQL Editor to bring your database fully up to date with
-- the current backend code.
--
-- This concatenates every additive sql/*.sql migration (in the
-- correct order) EXCEPT:
--
--   - sql/schema.sql - NOT included here. That file creates the base
--     tables with plain "create table" (no "if not exists"), which
--     will throw "relation already exists" and abort the whole paste
--     if your database already has these tables - and it clearly
--     does, since your backend is already running against it. Only
--     run schema.sql by itself, and only on a brand new, empty
--     database.
--
--   - sql/manual-account-activation.sql - a dev-only script that needs
--     YOUR real phone number and a hand-generated password hash filled
--     in first. Not something to run blindly as part of a batch.
--
-- Everything below IS safe to run even if some of it already exists -
-- every statement uses "if not exists" / "add column if not exists" /
-- "drop ... if exists" before re-creating / equivalent guards, so
-- nothing gets dropped, duplicated, or overwritten unexpectedly.
-- =====================================================================

-- ============================================================
-- SECTION: 2026-07-fixes.sql
-- ============================================================
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

-- ============================================================
-- SECTION: add-billing-period.sql
-- ============================================================
-- Adds the column the new monthly billing job uses to make sure a
-- tenant is only ever billed once per calendar period (prevents
-- double-charging if the job runs more than once on the same day, or
-- catches up after downtime).
--
-- paid_through_date is intentionally left in place (harmless, just
-- unused going forward) rather than dropped, so no historical data is
-- lost. balance_due is now the single source of truth for what a
-- tenant owes/has as credit; see src/utils/prepayment.js.

alter table tenants add column if not exists last_billed_period text;

-- One-time backfill: for tenants who already have an active billing
-- cycle (move-in date in the past, due day already passed this
-- month), mark them as billed for the current period so the first
-- run of the new job doesn't double-charge on top of whatever
-- balance_due already reflects from the old system. Adjust the month
-- below to match whenever you actually run this migration.
update tenants
set last_billed_period = to_char(now(), 'YYYY-MM')
where is_active = true
  and last_billed_period is null
  and extract(day from now()) >= coalesce(due_day_of_month, (select due_day_of_month from units where units.id = tenants.unit_id));

-- ============================================================
-- SECTION: add-photo-url.sql
-- ============================================================
-- =====================================================================
-- Migration: add photo_url to landlords and tenants
-- =====================================================================
-- Run once in Supabase SQL Editor. Stores a URL to a profile picture,
-- not the binary file itself - actual file upload/hosting (e.g. via
-- Supabase Storage) is a separate piece of work, scoped for later in
-- the same session this migration was requested in.

alter table landlords add column if not exists photo_url text;
alter table tenants add column if not exists photo_url text;

-- ============================================================
-- SECTION: add-paid-through-date.sql
-- ============================================================
-- =====================================================================
-- Migration: add paid_through_date to tenants
-- =====================================================================
-- Run this once in Supabase SQL Editor against your existing database.
-- Safe to run even if you already have tenant rows - the column
-- defaults to NULL for everyone (meaning "not tracked / no prepayment
-- yet"), nothing existing breaks.

alter table tenants
  add column if not exists paid_through_date date;

-- Optional: backfill an initial value for existing active tenants
-- based on their current due date, so the feature has a sane starting
-- point rather than NULL for tenants who already existed before this
-- migration. Adjust or skip this if you'd rather start everyone fresh.
--
-- update tenants t
-- set paid_through_date = (
--   select (date_trunc('month', current_date) +
--           (coalesce(t.due_day_of_month, u.due_day_of_month) - 1) * interval '1 day')::date
--   from units u where u.id = t.unit_id
-- )
-- where t.is_active = true and t.paid_through_date is null;

-- ============================================================
-- SECTION: add-guest-help-requests.sql
-- ============================================================
-- Migration: allow pre-login ("guest") help requests
-- Run this if your database was created before this change.
-- Lets the Login page's Help button submit a request before the
-- person has an account/token (blueprint 15: "help before logging in").

alter table help_requests drop constraint if exists help_requests_requester_type_check;
alter table help_requests add constraint help_requests_requester_type_check
  check (requester_type in ('landlord', 'tenant', 'guest'));

alter table help_requests alter column requester_id drop not null;

-- ============================================================
-- SECTION: add-platform-settings.sql
-- ============================================================
-- =====================================================================
-- Migration: add platform_settings table
-- =====================================================================
-- Run once in Supabase SQL Editor. Makes emergency lockdown actually
-- block logins platform-wide (landlords, tenants, and previously it
-- did neither correctly) instead of only flipping a field login()
-- never checked.

create table if not exists platform_settings (
  id int primary key default 1,
  is_locked_down boolean default false,
  lockdown_reason text,
  lockdown_started_at timestamptz,
  constraint single_row check (id = 1)
);

insert into platform_settings (id, is_locked_down)
values (1, false)
on conflict (id) do nothing;

-- ============================================================
-- SECTION: add-chat-messages.sql
-- ============================================================
-- =====================================================================
-- CHAT / DIRECT MESSAGING SYSTEM
-- Adds a real two-way chat between:
--   1) admin  <-> landlord   (replaces "reach us directly" with a live chat)
--   2) admin  <-> tenant     (same, from the tenant portal side)
--   3) landlord <-> tenant   ("text your landlord" inside the tenant portal,
--                             and the matching thread inside the landlord
--                             dashboard for that specific tenant)
--
-- Each row is one chat bubble. A conversation is identified by
-- (thread_type, landlord_id, tenant_id) - tenant_id is null for the
-- admin<->landlord thread, and both landlord_id/tenant_id are set for
-- the landlord<->tenant thread (tenant_id already implies landlord_id,
-- but we store both so admin can query "all threads for landlord X"
-- and "all threads for tenant Y" without a join).
--
-- reply_to_id gives the WhatsApp-style "reply to a specific bubble"
-- behaviour: the client greys out/quotes the referenced message above
-- the reply.
-- =====================================================================

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),

  thread_type text not null check (thread_type in ('admin_landlord', 'admin_tenant', 'landlord_tenant')),
  landlord_id uuid references landlords(id) on delete cascade, -- set for all thread types
  tenant_id uuid references tenants(id) on delete cascade,     -- set for admin_tenant and landlord_tenant

  sender_role text not null check (sender_role in ('admin', 'landlord', 'tenant')),
  sender_id uuid, -- landlords.id / tenants.id; null when sender_role = 'admin'
  sender_name text not null, -- snapshot at send-time so history reads fine even if the account is later renamed/removed

  body text not null,
  reply_to_id uuid references chat_messages(id) on delete set null,

  -- Read tracking is per-side (each thread only ever has two sides),
  -- rather than per-individual-admin-user, since any admin user
  -- reading a thread should mark it read for the whole admin team.
  read_by_admin boolean not null default false,
  read_by_landlord boolean not null default false,
  read_by_tenant boolean not null default false,

  created_at timestamptz not null default now()
);

-- A thread must reference the right owning IDs for its type.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_messages_thread_shape'
  ) then
    alter table chat_messages
      add constraint chat_messages_thread_shape check (
        (thread_type = 'admin_landlord' and landlord_id is not null and tenant_id is null) or
        (thread_type = 'admin_tenant'   and tenant_id is not null) or
        (thread_type = 'landlord_tenant' and landlord_id is not null and tenant_id is not null)
      );
  end if;
end $$;

create index if not exists idx_chat_admin_landlord on chat_messages(thread_type, landlord_id) where thread_type = 'admin_landlord';
create index if not exists idx_chat_admin_tenant on chat_messages(thread_type, tenant_id) where thread_type = 'admin_tenant';
create index if not exists idx_chat_landlord_tenant on chat_messages(thread_type, landlord_id, tenant_id) where thread_type = 'landlord_tenant';
create index if not exists idx_chat_created_at on chat_messages(created_at);
create index if not exists idx_chat_reply_to on chat_messages(reply_to_id);

-- ============================================================
-- SECTION: 2026-07-property-managers.sql
-- ============================================================
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

-- ============================================================
-- SECTION: add-caretaker-role-level.sql
-- ============================================================
-- =====================================================================
-- Adds a "role_level" to property_managers so a landlord can add
-- someone as either a full Property Manager or a more limited
-- Caretaker, without needing a whole separate account table - they
-- still log in as "manager" underneath, just with fewer permissions
-- when role_level = 'caretaker'.
--
-- Caretakers can: view properties/tenants they're assigned to, remind
-- tenants, send bulk reminders, revoke a vacating notice.
-- Caretakers cannot: delete a tenant, waive interest, transfer a
-- tenant between units, add/remove units, or add extra charges.
-- (Adding/removing properties, managers, and subscription/billing
-- were already landlord-only before this and are unaffected.)
-- =====================================================================

alter table property_managers add column if not exists role_level text not null default 'manager'
  check (role_level in ('manager', 'caretaker'));

-- ============================================================
-- SECTION: 2026-07-property-payments-caretaker.sql
-- ============================================================
-- =====================================================================
-- Follow-up to 2026-07-property-managers.sql: the "buy a new property"
-- flow (property.controller.js initiatePropertyPurchase / purchase-
-- Property in the frontend) was still writing the pre-migration
-- manager_name / manager_phone columns on property_payments, which are
-- never read anywhere else now that properties uses caretaker_name /
-- caretaker_phone. This adds the matching caretaker columns here too
-- so a caretaker set while paying for a brand-new property actually
-- survives onto the created properties row.
-- Run this in the Supabase SQL Editor AFTER 2026-07-property-managers.sql.
-- =====================================================================
alter table property_payments add column if not exists caretaker_name text;
alter table property_payments add column if not exists caretaker_phone text;

-- The old manager_name / manager_phone columns are kept (nothing is
-- deleted per project convention) but are no longer read or written.

-- ============================================================
-- SECTION: 2026-07-updates-v2.sql
-- ============================================================
-- =====================================================================
-- Migration: 2026-07 updates v2 (run this once in Supabase SQL Editor)
-- =====================================================================
-- Adds support for:
--   1. Paid "add a new property" flow from the landlord dashboard's
--      property switcher - a landlord can register another property
--      (name + unit count), pay for those units via M-Pesa STK push,
--      and only then does the property/units become usable - mirrors
--      the same pattern as subscription_payments.
-- =====================================================================

create table if not exists property_payments (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,

  -- Property details captured up-front, applied once payment completes
  name text not null,
  location text,
  county text,
  description text,
  manager_name text,
  manager_phone text,
  units_count integer not null,

  amount numeric not null,
  mpesa_checkout_request_id text,
  mpesa_transaction_id text,
  mpesa_phone text,
  status text not null default 'pending', -- pending | completed | failed

  created_property_id uuid references properties(id) on delete set null,

  paid_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_property_payments_landlord on property_payments(landlord_id);
create index if not exists idx_property_payments_checkout on property_payments(mpesa_checkout_request_id);

-- ============================================================
-- SECTION: 2026-07-notifications-inbox.sql
-- ============================================================
-- =====================================================================
-- Migration: in-portal notifications inbox (run once in Supabase SQL
-- Editor, after the other 2026-07-*.sql migrations).
-- =====================================================================
-- FIX: "when sending any reminder, be it bulk or any updates or
-- announcements, the message should be sent to the tenant's phone
-- number as well as the portal's inbox."
--
-- chat_messages (add-chat-messages.sql) is a two-party thread between
-- a specific admin/landlord/tenant pair - it's the wrong shape for a
-- one-way system notification that should show up in EVERY relevant
-- portal's inbox regardless of who's chatting with whom. This is a
-- separate, simple one-way notifications table instead: every SMS the
-- system already sends (rent reminders, overdue alerts, bulk
-- reminders, announcements, manager/caretaker changes, etc.) now also
-- writes one row here, and the portals show it under a bell/inbox
-- icon. Nothing about chat_messages changes.
-- =====================================================================

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),

  recipient_type text not null check (recipient_type in ('landlord', 'manager', 'tenant')),
  recipient_id uuid not null,

  title text not null,
  body text not null,

  category text default 'general', -- 'rent_reminder' | 'overdue' | 'announcement' | 'account' | 'general'

  read_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_notifications_recipient on notifications(recipient_type, recipient_id, created_at desc);
create index if not exists idx_notifications_unread on notifications(recipient_type, recipient_id) where read_at is null;
