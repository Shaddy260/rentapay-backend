-- =====================================================================
-- SCOUT ROLE — Phase 1 (schema only, no app code changes in this file)
--
-- Adds the fifth account type ("Scout") plus everything Phases 2-6
-- build on top of: per-county subscriptions (mirrors the existing
-- per-property subscription precedent in add-per-property-subscriptions.sql
-- — never a flat account-level status, since one county can expire
-- independently of another), tiered county pricing, landlord block/
-- opt-out controls, and a `scout_landlord` chat thread type.
--
-- Do NOT proceed to Phase 2 app code until every statement below has
-- actually been run AND verified (tables visible in Table Editor,
-- constraints present in pg_constraint) — a green checkmark on the
-- query alone is not verification, same lesson as every other
-- COMBINED-run-this-once.sql migration in this repo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Scout accounts
-- ---------------------------------------------------------------------
create table if not exists scouts (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  password_hash text not null,
  full_name text not null,
  email text,
  otp_code text,
  otp_expires_at timestamptz,
  is_verified boolean not null default false, -- mirrors landlords/tenants: set true by verifyOTP after signup
  is_active boolean not null default true,     -- admin-level suspend switch, same meaning as property_managers.is_active
  must_change_password boolean not null default false,
  failed_login_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_scouts_phone on scouts(phone);

-- ---------------------------------------------------------------------
-- Per-county subscriptions — one row per (scout, county), each with its
-- own expiry. A Scout might add Nairobi in January and Kiambu in June;
-- they must not share a renewal date.
-- ---------------------------------------------------------------------
create table if not exists scout_county_subscriptions (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid not null references scouts(id) on delete cascade,
  county text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null check (status in ('active', 'expired')),
  unique (scout_id, county)
);

create index if not exists idx_scout_county_subs_scout on scout_county_subscriptions(scout_id);
create index if not exists idx_scout_county_subs_expiry on scout_county_subscriptions(county, expires_at);

-- ---------------------------------------------------------------------
-- County pricing tiers — a lookup table, not hardcoded, so prices can
-- be retuned later without a schema change.
-- ---------------------------------------------------------------------
create table if not exists county_pricing_tiers (
  county text primary key,
  tier smallint not null,
  annual_price numeric(10,2) not null
);

insert into county_pricing_tiers (county, tier, annual_price) values
  ('Nairobi', 1, 4000), ('Mombasa', 1, 4000), ('Kiambu', 1, 4000), ('Nakuru', 1, 4000),
  ('Kisumu', 2, 2500), ('Uasin Gishu', 2, 2500), ('Machakos', 2, 2500), ('Kajiado', 2, 2500)
on conflict (county) do nothing;
-- Every other Kenyan county: insert at tier 3, annual_price 1200.
-- FOLLOW-UP (not yet run — do this once the full 47-county list is
-- finalized against constants/kenyaCounties.js, so the lookup table and
-- the frontend's county dropdown never disagree on what counties exist):
--
--   insert into county_pricing_tiers (county, tier, annual_price)
--   select county_name, 3, 1200
--   from unnest(array[...all 47 counties from kenyaCounties.js...]) as county_name
--   on conflict (county) do nothing;

-- ---------------------------------------------------------------------
-- Landlord can block a specific scout from all their properties
-- ---------------------------------------------------------------------
create table if not exists blocked_scouts (
  landlord_id uuid not null references landlords(id) on delete cascade,
  scout_id uuid not null references scouts(id) on delete cascade,
  blocked_at timestamptz not null default now(),
  primary key (landlord_id, scout_id)
);

-- ---------------------------------------------------------------------
-- Per-landlord opt-out of Scout visibility, plus tracking whether
-- they've seen the one-time disclosure (Phase 5f).
-- ---------------------------------------------------------------------
alter table landlords add column if not exists scout_visibility_enabled boolean not null default true;
alter table landlords add column if not exists scout_disclosure_seen_at timestamptz;

-- ---------------------------------------------------------------------
-- Chat extension for masked scout<->landlord contact (Phase 5e)
--
-- IMPORTANT: chat_messages has already been migrated once since it was
-- first created (see 2026-07-chat-delete.sql), which DROPPED and
-- RE-ADDED the sender_role check under a new explicit name
-- (chat_messages_sender_role_check) and widened it to include
-- 'manager', and added a *separate* named shape constraint
-- (chat_messages_thread_shape) distinct from the inline, auto-named
-- thread_type check (chat_messages_thread_type_check). This migration
-- updates all three, plus the newer chat_message_hidden.viewer_role
-- check and deleted_by_role check added in that same file — not just
-- the ones the original add-chat-messages.sql defined. Confirm these
-- constraint names still match pg_constraint in your instance before
-- running (`select conname from pg_constraint where conrelid =
-- 'chat_messages'::regclass;`) in case anything has moved again since.
-- ---------------------------------------------------------------------

alter table chat_messages add column if not exists scout_id uuid references scouts(id) on delete cascade;
alter table chat_messages add column if not exists read_by_scout boolean not null default false;

-- thread_type: widen the inline check to add 'scout_landlord'
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_thread_type_check') then
    alter table chat_messages drop constraint chat_messages_thread_type_check;
  end if;
end $$;

alter table chat_messages
  add constraint chat_messages_thread_type_check
  check (thread_type in ('admin_landlord', 'admin_tenant', 'landlord_tenant', 'scout_landlord'));

-- shape: widen the named shape constraint to add the scout_landlord case
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_thread_shape') then
    alter table chat_messages drop constraint chat_messages_thread_shape;
  end if;
end $$;

alter table chat_messages
  add constraint chat_messages_thread_shape check (
    (thread_type = 'admin_landlord'  and landlord_id is not null and tenant_id is null and scout_id is null) or
    (thread_type = 'admin_tenant'    and tenant_id is not null) or
    (thread_type = 'landlord_tenant' and landlord_id is not null and tenant_id is not null and scout_id is null) or
    (thread_type = 'scout_landlord'  and scout_id is not null and landlord_id is not null and tenant_id is null)
  );

-- sender_role: widen to add 'scout' alongside the existing 'manager' widening
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_sender_role_check') then
    alter table chat_messages drop constraint chat_messages_sender_role_check;
  end if;
end $$;

alter table chat_messages
  add constraint chat_messages_sender_role_check
  check (sender_role in ('admin', 'landlord', 'manager', 'tenant', 'scout'));

-- deleted_by_role: same widening, so a scout deleting their own message
-- (delete-for-everyone) doesn't hit a check-constraint 500 later
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_deleted_by_role_check') then
    alter table chat_messages drop constraint chat_messages_deleted_by_role_check;
  end if;
end $$;

alter table chat_messages
  add constraint chat_messages_deleted_by_role_check
  check (deleted_by_role in ('admin', 'landlord', 'manager', 'tenant', 'scout'));

-- chat_message_hidden.viewer_role: same widening, for delete-for-me
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_message_hidden_viewer_role_check') then
    alter table chat_message_hidden drop constraint chat_message_hidden_viewer_role_check;
  end if;
end $$;

alter table chat_message_hidden
  add constraint chat_message_hidden_viewer_role_check
  check (viewer_role in ('admin', 'landlord', 'manager', 'tenant', 'scout'));

create index if not exists idx_chat_scout_landlord on chat_messages(thread_type, scout_id, landlord_id) where thread_type = 'scout_landlord';

-- =====================================================================
-- VERIFICATION — run these after the above and eyeball the output
-- before touching any app code:
--
--   select table_name from information_schema.tables
--     where table_name in ('scouts','scout_county_subscriptions','county_pricing_tiers','blocked_scouts');
--
--   select column_name from information_schema.columns
--     where table_name = 'landlords' and column_name in ('scout_visibility_enabled','scout_disclosure_seen_at');
--
--   select column_name from information_schema.columns
--     where table_name = 'chat_messages' and column_name in ('scout_id','read_by_scout');
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'chat_messages'::regclass and contype = 'c';
-- =====================================================================
