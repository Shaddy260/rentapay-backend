-- =====================================================================
-- Tenant rating reminder popups
-- DIRECT REQUEST: landlords/managers/caretakers get an occasional,
-- dismissible popup nudging them to rate a tenant that hasn't been
-- rated yet - either at random, or right after that tenant's payment
-- is confirmed. Nothing here changes existing rating data; it only
-- tracks *when to surface a nudge* to a given staff member.
-- Run in the Supabase SQL Editor after 2026-07-tenant-rating-rater-role.sql.
-- =====================================================================

create table if not exists tenant_rating_reminders (
  id uuid primary key default gen_random_uuid(),

  landlord_id uuid not null references landlords(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  property_id uuid references properties(id) on delete cascade,

  -- Who the nudge is for. rater_user_type is 'landlord' or
  -- 'property_manager' (covers both manager and caretaker logins,
  -- same convention as property_managers.role_level); rater_role
  -- mirrors tenant_ratings.rater_role for readability in the UI.
  rater_user_type text not null check (rater_user_type in ('landlord', 'property_manager')),
  rater_user_id uuid not null,
  rater_role text not null check (rater_role in ('landlord', 'manager', 'caretaker')),

  trigger_reason text not null default 'unrated' check (trigger_reason in ('unrated', 'payment')),

  snoozed_until timestamptz,
  dismissed_today_date date, -- "not today" - re-eligible once the date rolls over
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, rater_user_type, rater_user_id)
);

create index if not exists idx_rating_reminders_lookup
  on tenant_rating_reminders (rater_user_type, rater_user_id, snoozed_until);

create index if not exists idx_rating_reminders_tenant
  on tenant_rating_reminders (tenant_id);
