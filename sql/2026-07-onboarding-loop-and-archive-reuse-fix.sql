-- =====================================================================
-- Migration: onboarding loop bug (permanent fix) + archived
-- tenant/manager/caretaker phone reuse (permanent fix)
-- Run this once in the Supabase SQL Editor. Safe to re-run - every
-- statement is idempotent ("if not exists" / "if exists" guards).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ONBOARDING LOOP BUG (root cause)
-- ---------------------------------------------------------------------
-- setup_wizard_complete was only ever created inside schema.sql's
-- original "create table landlords" statement - unlike every other
-- schema change in this project, it never got an idempotent
-- "alter table ... add column if not exists" migration of its own.
-- Any database created before this column was added to schema.sql
-- simply does not have it. Without the column:
--   - completeSetupWizard() (auth.controller.js) fails on every call
--     (Supabase can't find the column to update)
--   - setup_wizard_complete never becomes true
--   - login()'s setupWizardComplete check is always false/undefined
--   - Login.jsx bounces the landlord back into RegisterFlow forever,
--     even though they already finished the wizard UI
-- This is the permanent fix: add the column the same idempotent way
-- must_change_password was added in 2026-07-fixes.sql.
alter table landlords add column if not exists setup_wizard_complete boolean default false;

-- ---------------------------------------------------------------------
-- 2. ARCHIVED MANAGER/CARETAKER PHONE REUSE (root cause)
-- ---------------------------------------------------------------------
-- property_managers.phone was created with a plain "unique" constraint
-- (schema.sql / 2026-07-property-managers.sql), scoped across ALL rows
-- regardless of is_active. That means once a landlord removes
-- (archives) a manager or caretaker, that phone number can NEVER be
-- reused for a new property_managers row again, anywhere on the
-- platform - even after the app-level checks in phoneUniqueness.js /
-- emailUniqueness.js were fixed to allow it, the INSERT itself would
-- still fail with a duplicate-key error at the database level.
--
-- Fix: drop the blanket unique constraint and replace it with a
-- partial unique index that only applies to ACTIVE rows - mirroring
-- how tenants (which have no such constraint at all) already allow an
-- archived person's phone to be reused under a new landlord.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'property_managers_phone_key'
  ) then
    alter table property_managers drop constraint property_managers_phone_key;
  end if;
end $$;

create unique index if not exists uq_property_managers_phone_active
  on property_managers (phone)
  where is_active = true;

-- Note: idx_property_managers_phone (a plain, non-unique index on
-- phone) already exists from 2026-07-property-managers.sql and still
-- covers lookup performance now that the unique constraint is gone -
-- no need to recreate it here.
