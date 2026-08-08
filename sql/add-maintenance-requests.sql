-- =====================================================================
-- Direct request: "maintenance/repair ticketing." Deliberately a
-- separate table from help_requests - help_requests is wired to
-- RentaPay's own admin support inbox (see help.controller.js, which
-- emails SUPER_ADMIN_EMAIL), which is the wrong destination for "my
-- tap is leaking" - that needs to reach the actual landlord/caretaker
-- who manages the property, not RentaPay's support team. The existing
-- "Complaints" panel in both portals currently reuses help_requests
-- for exactly this, which means tenant maintenance issues have been
-- landing only in RentaPay's own inbox, invisible to the landlord.
-- This table is what the landlord/caretaker actually needs to see.
-- =====================================================================

create table if not exists maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  property_id uuid references properties(id) on delete set null,
  landlord_id uuid not null references landlords(id) on delete cascade,
  title text not null,
  description text,
  photo_url text,
  -- 'open'         - just submitted, nobody has picked it up
  -- 'in_progress'  - a caretaker/landlord/manager is on it
  -- 'resolved'     - fixed
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_type text, -- 'landlord' | 'manager'
  resolved_by_id uuid
);

create index if not exists idx_maintenance_requests_tenant on maintenance_requests(tenant_id);
create index if not exists idx_maintenance_requests_landlord_status on maintenance_requests(landlord_id, status);
create index if not exists idx_maintenance_requests_property on maintenance_requests(property_id);
