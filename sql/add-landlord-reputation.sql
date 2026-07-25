-- =====================================================================
-- Mirror side of add-tenant-reputation.sql, same request thread:
-- tenants rating landlords. Kept aggregated-only by design (see
-- reputation notes) - "not a single visible review that exposes a
-- still-living-there tenant to retaliation, but enough to warn a
-- prospective tenant" about response times, deposit handling, etc.
-- So this table stores individual ratings (for averaging), but the
-- API never returns a single rating attributed to an identifiable
-- tenant back out - only the aggregate. See landlordReputation.service.js.
-- =====================================================================

create table if not exists landlord_ratings (
  id uuid primary key default gen_random_uuid(),

  landlord_id uuid not null references landlords(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete set null,

  rating int not null check (rating between 1 and 5),
  category text not null default 'overall' check (category in ('overall', 'maintenance_response', 'deposit_handling', 'communication')),
  comment text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_landlord_ratings_landlord on landlord_ratings(landlord_id);

-- One active rating per tenant+landlord+category - a tenant updating
-- their rating replaces it rather than stacking duplicates, same
-- pattern as tenant_ratings in add-tenant-reputation.sql.
create unique index if not exists uq_landlord_rating_tenant_category
  on landlord_ratings(tenant_id, landlord_id, category);
