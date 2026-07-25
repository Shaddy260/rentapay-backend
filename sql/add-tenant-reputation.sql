-- =====================================================================
-- Direct request: landlords can rate tenants, and that rating feeds
-- into a tenant reputation that is PORTABLE by email - it follows the
-- tenant to whichever landlord adds them next, the same way the
-- payment-reputation idea (see rentapay-notes) was meant to work.
--
-- Ratings are kept in their own table, one row per rating, rather than
-- a single mutable score on the tenant row, for the same reason
-- payments aren't collapsed into a running balance only: history
-- (who rated what, when, and why) has to survive archiving, restoring,
-- and the tenant moving to a completely different landlord.
--
-- Keyed by tenant_email (lowercased) as the durable cross-landlord
-- identity thread - matches the reasoning already used for phone
-- uniqueness in phoneUniqueness.js, but email is deliberately used
-- here instead of phone since that's the anchor the reputation idea
-- was built around (numbers get recycled, emails don't).
-- =====================================================================

create table if not exists tenant_ratings (
  id uuid primary key default gen_random_uuid(),

  -- Who rated, and about which tenant record at the time of rating.
  -- tenant_id is kept for traceability/display ("rated while at Unit
  -- X") but is NOT the aggregation key - a tenant can have several
  -- different tenant_id rows over their lifetime (one per landlord),
  -- and the rating has to keep counting even after that specific
  -- tenant_id is archived/deleted.
  landlord_id uuid not null references landlords(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete set null,
  unit_id uuid references units(id) on delete set null,

  -- Portable identity key. Always lowercased/trimmed on write.
  tenant_email text not null,
  tenant_phone text,
  tenant_name_at_rating text not null,

  rating int not null check (rating between 1 and 5),
  category text not null default 'overall' check (category in ('overall', 'payment', 'property_care', 'communication', 'conduct')),
  comment text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_tenant_ratings_email on tenant_ratings(tenant_email);
create index if not exists idx_tenant_ratings_landlord on tenant_ratings(landlord_id);
create index if not exists idx_tenant_ratings_tenant on tenant_ratings(tenant_id);

-- A landlord can update their own rating of a given tenant (by email)
-- rather than stacking a fresh row every time they re-rate the same
-- tenancy - one active "overall" rating per landlord+tenant email.
create unique index if not exists uq_tenant_rating_landlord_email_category
  on tenant_ratings(landlord_id, tenant_email, category);
