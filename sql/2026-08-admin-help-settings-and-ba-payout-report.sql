-- =====================================================================
-- Admin > Settings > "Help & Contact Details" + BA Regions & Payout
-- Qualification Report.
--
-- IMPORTANT - adapted from a patch that was written against an assumed
-- schema before the real backend was available. Two things changed
-- from the original patch so it actually matches this project:
--
-- 1) `platform_settings` ALREADY EXISTS in this project as a single
--    fixed row (id = 1: is_locked_down / lockdown_reason /
--    admin_password_hash, see sql/add-platform-settings.sql and
--    auth.controller.js's adminLogin). The original patch's
--    `CREATE TABLE IF NOT EXISTS platform_settings (key, value, ...)`
--    would have silently no-opped against that (IF NOT EXISTS sees a
--    table already named platform_settings and skips creation), so
--    the Help & Contact Details feature would look like it worked in
--    review but never actually persist anything. Using a distinctly
--    named table here instead: `admin_help_contact_settings`.
--
-- 2) This codebase has NO `admins` table (admin auth is a single
--    env/DB-stored credential; every admin-authored row elsewhere -
--    activity_logs.actor_id, ba_landlord_claims.marked_paid_by, etc. -
--    stores the literal admin id as plain text, currently always
--    'super-admin'; see auth.controller.js's adminLogin/signToken and
--    add-brand-ambassador-role.sql's note on this). So
--    "updated_by_admin_id" / "generated_by_admin_id" below are plain
--    `text`, not an integer FK, matching that convention.
--
-- Also: brand_ambassadors has no `region` column and landlords has no
-- `location` column (only `county`/`constituency`) - the "BA Regions"
-- report below groups by the landlord's county instead of an
-- assumed-but-nonexistent ba.region field. And ba_landlord_claims'
-- status column is actually named `qualification_status` with values
-- ('pending','qualified','paid','not_paid'), and claims reference a
-- landlord via `matched_landlord_id`, not `landlord_id`.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Admin-editable Help & Contact Details (WhatsApp/Call/Email),
--    read by every portal's Help modal - including the logged-out
--    login screen - so it's a public GET.
-- ---------------------------------------------------------------------
create table if not exists admin_help_contact_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by_admin_id text
);

-- Seed with the values previously hardcoded on the frontend, so
-- behaviour is unchanged until an admin edits them from
-- Settings > Help & Contact Details.
insert into admin_help_contact_settings (key, value)
values
  ('help_whatsapp', '+254710888917'),
  ('help_call', '254710888917'),
  ('help_email', 'support@rentapay.co.ke')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 2) BA Regions & Payout Qualification Report - point-in-time
--    snapshots generated from Admin > Brand Ambassadors. Kept as a
--    stable, shareable artifact rather than a live query, so it
--    doesn't change under the team's feet if claims get marked
--    paid/qualified a minute after it's generated/shared.
-- ---------------------------------------------------------------------
create table if not exists ba_payout_qualification_reports (
  id uuid primary key default gen_random_uuid(),
  period_type text not null default 'month' check (period_type in ('month', 'custom')),
  period_key text not null, -- e.g. '2026-08'
  generated_at timestamptz not null default now(),
  generated_by_admin_id text,
  generated_by_admin_name text,
  totals_region_count int not null default 0,
  totals_ba_count int not null default 0,
  totals_landlords int not null default 0,
  totals_qualifying int not null default 0,
  totals_not_qualifying int not null default 0
);

create index if not exists idx_ba_payout_qual_reports_period
  on ba_payout_qualification_reports (period_key);

-- One row per onboarded landlord captured in the snapshot. Phone is
-- stored ALREADY MASKED (middle digits starred) - this table backs a
-- downloadable/shareable file, so the raw number is deliberately
-- never persisted here; look up landlords.phone directly if the full
-- number is ever needed for an authorised purpose.
--
-- ba_id/landlord_id use ON DELETE SET NULL (never cascade), matching
-- this project's Money & Data Integrity Rules (see
-- add-brand-ambassador-role.sql) - deleting a BA or landlord later
-- must never retroactively erase a past report; the *_name/*_code
-- snapshots below survive it either way.
create table if not exists ba_payout_qualification_report_entries (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references ba_payout_qualification_reports(id) on delete cascade,
  region text not null default 'Unspecified',
  ba_id uuid references brand_ambassadors(id) on delete set null,
  ba_name text not null,
  ba_code text,
  landlord_id uuid references landlords(id) on delete set null,
  landlord_name text not null,
  landlord_phone_masked text not null,
  county text,
  onboarded_at timestamptz,
  qualifies boolean not null default false,
  reason text -- short human reason when qualifies = false, e.g. "Claim status: pending"
);

create index if not exists idx_ba_payout_qual_entries_report
  on ba_payout_qualification_report_entries (report_id);
create index if not exists idx_ba_payout_qual_entries_region
  on ba_payout_qualification_report_entries (report_id, region);
create index if not exists idx_ba_payout_qual_entries_ba
  on ba_payout_qualification_report_entries (report_id, ba_id);
