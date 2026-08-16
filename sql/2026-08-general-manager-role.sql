-- ---------------------------------------------------------------------
-- RentaPay — General Manager Accounts (Sectioned Build Spec)
-- Section 2 — General Manager Role & Account Creation
-- ---------------------------------------------------------------------
-- A new, admin-provisioned-only account type. Deliberately named
-- "General Manager" (not "Manager") to avoid any confusion with the
-- existing property_managers table/role, which is unrelated - a
-- property manager is added BY a landlord to help run that landlord's
-- own properties; a General Manager is added BY admin and (per later
-- sections of this spec) gets near-admin visibility across the whole
-- platform.
--
-- This migration is intentionally minimal - only what Section 2
-- (account creation) needs. Later sections of the same spec
-- (Operations PIN, dashboard scope, edit logging, revert capability)
-- each get their own follow-up migration that ALTERs this table
-- rather than everything being front-loaded here, matching the
-- spec's own "build top to bottom, nothing depends on something that
-- hasn't been built yet" instruction.
-- ---------------------------------------------------------------------

create table if not exists general_managers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null,
  email text not null,
  password_hash text not null,
  -- Auto-verified at creation, same reasoning as property_managers:
  -- admin already vouches for this account by creating it directly,
  -- so there's no self-service OTP step - just a forced password
  -- change on first login (see must_change_password below).
  is_verified boolean not null default true,
  must_change_password boolean not null default true,
  is_active boolean not null default true,
  gender text check (gender in ('male', 'female')),
  -- Free-text marker of who provisioned this account. There is no
  -- separate "admins" table in this codebase (admin is a single
  -- shared super-admin login) - kept as text for consistency with how
  -- activity_logs already records admin-actor rows elsewhere (see
  -- actorId: 'super-admin' convention in the codebase).
  created_by_admin text not null default 'super-admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_general_managers_phone on general_managers (phone);
create unique index if not exists idx_general_managers_email on general_managers (lower(email));
create index if not exists idx_general_managers_is_active on general_managers (is_active);

-- Done when: admin has a working UI to create a General Manager
-- account (see generalManager.controller.js), and no other role or
-- self-signup path can create one (no public route exists anywhere
-- else in the API for this table).
