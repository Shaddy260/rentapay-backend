-- =====================================================================
-- Item 3: Admin Help & Contact Details - support MULTIPLE phone/
-- WhatsApp numbers instead of exactly one of each.
--
-- The existing `admin_help_contact_settings` table (see
-- 2026-08-admin-help-settings-and-ba-payout-report.sql) is a
-- single-row-per-key store - fine for `help_email` (there's still
-- only ever one support email) but wrong for call/WhatsApp numbers,
-- which now need to be a real list an admin can add/edit/remove from
-- (primary line, backup line, per-shift line, etc). This migration:
--
--   1) Adds a proper `help_contact_numbers` table (one row per
--      number), and
--   2) Migrates the two existing single-value rows
--      (`help_whatsapp` / `help_call`) out of
--      `admin_help_contact_settings` into it, so nothing an admin
--      already configured is lost.
--
-- `help_email` stays exactly where it is in
-- `admin_help_contact_settings` - only call/WhatsApp become a list.
-- =====================================================================

create table if not exists help_contact_numbers (
  id uuid primary key default gen_random_uuid(),
  label text not null default '',
  type text not null check (type in ('call', 'whatsapp')),
  value text not null,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_admin_id text
);

create index if not exists idx_help_contact_numbers_type_active
  on help_contact_numbers (type, is_active, sort_order);

-- One-time migration of whatever single call/WhatsApp values are
-- currently configured (or the hardcoded defaults if none were ever
-- saved) into the new list table, as each type's first/primary entry.
-- Idempotent: only runs if the new table is still empty, so re-running
-- this file (or running it after an admin has already started using
-- the new list) never duplicates or clobbers rows.
insert into help_contact_numbers (label, type, value, sort_order, is_active)
select 'Primary', 'whatsapp', coalesce(
  (select value from admin_help_contact_settings where key = 'help_whatsapp'),
  '+254710888917'
), 0, true
where not exists (select 1 from help_contact_numbers where type = 'whatsapp');

insert into help_contact_numbers (label, type, value, sort_order, is_active)
select 'Primary', 'call', coalesce(
  (select value from admin_help_contact_settings where key = 'help_call'),
  '254710888917'
), 0, true
where not exists (select 1 from help_contact_numbers where type = 'call');

-- The old single-value keys are left in place in
-- admin_help_contact_settings (harmless, unused going forward) rather
-- than deleted, in case anything still reads them during rollout -
-- application code no longer writes to help_whatsapp/help_call after
-- this migration ships.
