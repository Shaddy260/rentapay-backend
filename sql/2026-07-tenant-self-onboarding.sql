-- =====================================================================
-- Tenant Self-Onboarding via Shared Link
-- Run this in the Supabase SQL Editor AFTER schema.sql and
-- 2026-07-property-managers.sql (needs property_managers +
-- property_manager_assignments).
--
-- Lets a landlord/manager/caretaker generate one shareable link per
-- property. Tenants open it, pick their own vacant unit, fill in the
-- same details a landlord would type when adding them manually, and
-- submit for review. Any of the three roles can then edit/confirm the
-- request, which writes it into the unit exactly like a manual
-- "add tenant" would.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ONBOARDING LINKS - one per property. Ungrouped units (property_id
-- null) don't get a self-onboarding link; there's no "Units page for
-- this property" to hang the persistent bar off in that case.
-- ---------------------------------------------------------------------
create table if not exists tenant_onboarding_links (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  token text not null unique,

  created_at timestamptz default now()
);

create unique index if not exists idx_onboarding_links_property on tenant_onboarding_links(property_id);
create index if not exists idx_onboarding_links_landlord on tenant_onboarding_links(landlord_id);
create index if not exists idx_onboarding_links_token on tenant_onboarding_links(token);

-- ---------------------------------------------------------------------
-- ONBOARDING REQUESTS - what a tenant submitted through the public
-- form, pending review. On confirm, this becomes a real row in
-- `tenants` (resulting_tenant_id points at it) exactly the way a
-- manual "add tenant" would.
-- ---------------------------------------------------------------------
create table if not exists tenant_onboarding_requests (
  id uuid primary key default gen_random_uuid(),
  onboarding_link_id uuid not null references tenant_onboarding_links(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,

  -- Same field list tenants would otherwise have typed in for them by
  -- a landlord/manager/caretaker (tenant.controller.js's addTenant),
  -- minus the landlord-only decisions (rent override, due-day
  -- override, deposit) that aren't the tenant's to self-report.
  full_name text not null,
  primary_phone text not null,
  secondary_phone text,
  email text not null,
  id_number text not null,
  move_in_date date not null,
  emergency_contact_name text not null,
  emergency_contact_phone text not null,

  status text not null check (status in ('pending', 'confirmed', 'superseded')) default 'pending',

  confirmed_by_type text check (confirmed_by_type in ('landlord', 'manager')),
  -- Denormalized from property_managers.role_level at confirm time
  -- (same convention as staff_ratings.role_level elsewhere in this
  -- schema) - null when confirmed_by_type = 'landlord', since a
  -- landlord has no role_level. Lets "how many requests did
  -- caretakers vs full managers confirm" be queried directly instead
  -- of parsed out of confirmed_by_name.
  confirmed_by_role_level text check (confirmed_by_role_level in ('manager', 'caretaker')),
  confirmed_by_id uuid,
  confirmed_by_name text,
  confirmed_at timestamptz,

  superseded_reason text,
  resulting_tenant_id uuid references tenants(id) on delete set null,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_onboarding_requests_unit on tenant_onboarding_requests(unit_id);
create index if not exists idx_onboarding_requests_property on tenant_onboarding_requests(property_id);
create index if not exists idx_onboarding_requests_link on tenant_onboarding_requests(onboarding_link_id);
create index if not exists idx_onboarding_requests_landlord_status on tenant_onboarding_requests(landlord_id, status);

-- Resubmission logic (blueprint section 4): the SAME tenant (same
-- phone) resubmitting for the SAME unit, on the same property's
-- link, before anyone has confirmed, updates their existing pending
-- row instead of creating a duplicate - enforced here so a race
-- between two rapid submits can't slip two pending rows past the
-- app-level check. Scoped to unit_id as well as phone (not just
-- phone) so this stays a pure race-condition guard rather than
-- silently merging two genuinely different unit selections from the
-- same phone into one row - see submitOnboardingRequest's own lookup,
-- which matches this same (link, unit, phone) scope.
-- Different tenants submitting for the same unit are NOT blocked by
-- this - that's the "simultaneous duplicate" case, resolved at
-- confirm time by superseding the other pending request(s) for that
-- unit, not by preventing them from being submitted in the first place.
create unique index if not exists idx_onboarding_requests_pending_unit_phone_per_link
  on tenant_onboarding_requests(onboarding_link_id, unit_id, primary_phone) where status = 'pending';

drop trigger if exists trg_onboarding_requests_updated_at on tenant_onboarding_requests;
create trigger trg_onboarding_requests_updated_at before update on tenant_onboarding_requests
  for each row execute function set_updated_at();
