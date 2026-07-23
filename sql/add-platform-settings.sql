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
