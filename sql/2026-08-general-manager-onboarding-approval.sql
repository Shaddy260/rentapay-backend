-- =====================================================================
-- GENERAL MANAGER ROLE - ADMIN APPROVAL FOR SELF-SERVICE ONBOARDING
--
-- FIX: submitGmOnboarding (the public "invitee fills in their own
-- details" flow behind the admin-generated link) was activating the
-- account immediately on submission - is_active defaulted to true and
-- login credentials were emailed straight away. Anyone who obtained
-- the live link (it is a single shared URL, not single-use/per-person)
-- could submit their own details and get a working General Manager
-- account with near-admin platform visibility, with no admin review
-- step at all.
--
-- This migration brings the GM self-onboarding flow in line with the
-- Brand Ambassador one (see brand_ambassadors.status /
-- 'pending_approval'): a submission now lands in a pending queue and
-- does NOT touch is_active or send credentials until admin explicitly
-- approves it (or rejects it) from the admin portal.
-- =====================================================================

alter table general_managers
  add column if not exists status text not null default 'active'
    check (status in ('pending_approval', 'active', 'rejected'));

-- A pending application has no credentials yet - password_hash isn't
-- set until approval (approveGmApplication), so it can no longer be
-- mandatory at insert time.
alter table general_managers alter column password_hash drop not null;

-- Existing rows (all admin-typed-in via createGeneralManager, or
-- already-approved before this migration) are already 'active' by
-- the column default above - nothing to backfill.

alter table general_managers add column if not exists rejected_reason text;
alter table general_managers add column if not exists reviewed_by_admin_id text;
alter table general_managers add column if not exists reviewed_at timestamptz;

create index if not exists idx_general_managers_status on general_managers (status);

-- A pending/rejected application must not permanently block a real
-- person's phone/email from ever registering - mirrors the partial
-- unique indexes already used for brand_ambassadors (Phase 1) and for
-- this same table's existing plain unique indexes. Drop the old
-- always-on unique indexes and replace them with ones scoped to rows
-- that aren't rejected.
drop index if exists idx_general_managers_phone;
drop index if exists idx_general_managers_email;

create unique index if not exists idx_general_managers_phone_active
  on general_managers (phone) where status <> 'rejected';
create unique index if not exists idx_general_managers_email_active
  on general_managers (lower(email)) where status <> 'rejected';

-- Done when: a General Manager onboarding-link submission creates a
-- 'pending_approval' row with is_active = false and sends no
-- credentials, admin has Approve/Reject endpoints that flip it to
-- 'active' (is_active = true, temp password generated, credentials
-- emailed) or 'rejected', and generalManagerLogin refuses any account
-- whose status isn't 'active' with a status-appropriate message.
