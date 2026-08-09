-- =====================================================================
-- 2026-07-updates-v3.sql
--
-- Covers, in order:
--   1. Per-unit payment method override (units table).
--   2. Announcement sender tagging (Landlord / Property Manager /
--      Caretaker / System / RentaPay) + admin platform-wide broadcasts.
--   3. "Delete for me" vs "delete for everyone" on announcements.
--
-- Safe to run multiple times (every statement is guarded).
-- Run this in the Supabase SQL Editor AFTER 2026-07-announcements.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Per-unit payment method override
--
-- General/default payment method (landlords.payment_method etc.) is
-- untouched and still applies to every unit by default. These columns
-- let a specific unit override it - when payment_override_enabled is
-- true, buildPaymentInstructions() (src/utils/paymentInstructions.js)
-- prefers these fields over the landlord's own for that unit only.
-- ---------------------------------------------------------------------
alter table units add column if not exists payment_override_enabled boolean not null default false;
alter table units add column if not exists payment_override_method text
  check (payment_override_method in ('stk', 'paybill', 'till'));
alter table units add column if not exists payment_override_paybill_number text;
alter table units add column if not exists payment_override_paybill_account_number text;
alter table units add column if not exists payment_override_till_number text;

-- ---------------------------------------------------------------------
-- 2. Announcement sender tagging + platform-wide broadcasts
--
-- sender_role records who/what actually sent it, so the UI can show
-- "Landlord" / "Property Manager" / "Caretaker" / "System" / "RentaPay"
-- next to each message rather than guessing from context.
--
-- landlord_id becomes nullable + is_platform is added because an admin
-- platform-wide broadcast isn't scoped to any single landlord's
-- account at all - it goes out to literally everyone.
-- ---------------------------------------------------------------------
alter table announcements alter column landlord_id drop not null;

alter table announcements add column if not exists sender_role text not null default 'system'
  check (sender_role in ('landlord', 'manager', 'caretaker', 'system', 'platform'));
alter table announcements add column if not exists sender_id uuid;
alter table announcements add column if not exists is_platform boolean not null default false;

-- Backfill best-effort: anything already flagged is_system becomes
-- sender_role 'system'; everything else assumed sent by the landlord
-- (the old schema had no way to tell a manager's send from the
-- landlord's own, so this is a reasonable default for historical rows).
update announcements set sender_role = 'system' where is_system = true and sender_role = 'system';
update announcements set sender_role = 'landlord' where is_system = false and sender_role = 'system';

create index if not exists idx_announcements_platform on announcements(is_platform, created_at desc);

-- ---------------------------------------------------------------------
-- 3. Delete for me / delete for everyone
--
-- "Delete for everyone" (landlord/manager/caretaker only, and only for
-- announcements that belong to their own account) hard-deletes the row
-- via the existing DELETE endpoint - no new table needed for that.
--
-- "Delete for me" - available to every role, including tenants, and
-- the ONLY option tenants get - just hides the announcement for that
-- one recipient without touching it for anyone else. Same
-- recipient_type/recipient_id shape as announcement_reads for the same
-- id-collision-safety reason.
-- ---------------------------------------------------------------------
create table if not exists announcement_hidden (
  announcement_id uuid not null references announcements(id) on delete cascade,
  recipient_type text not null check (recipient_type in ('tenant', 'manager', 'landlord')),
  recipient_id uuid not null,
  hidden_at timestamptz not null default now(),
  primary key (announcement_id, recipient_type, recipient_id)
);
