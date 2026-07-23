-- =====================================================================
-- Direct request: "twice as fast, ultra navigation." Compression and
-- parallel queries (see server.js / dashboard.controller.js) cut down
-- on network time and round-trip count; this cuts down on how long
-- the database itself takes to answer the queries those round-trips
-- are making. Every index below matches a WHERE/IN clause that's hit
-- on nearly every dashboard, unit-detail, or tenant-portal load -
-- without it, Postgres has to scan every row in the table instead of
-- jumping straight to the ones that match.
-- =====================================================================

-- payments.unit_id is filtered on the unit detail page and the
-- dashboard's "this month's payments" query - had no index at all
-- before this (only tenant_id and landlord_id did).
create index if not exists idx_payments_unit on payments(unit_id);

-- Every dashboard/tenant-list load filters tenants by landlord_id AND
-- is_active together (active tenants only) - a composite index here
-- serves that combination directly instead of matching landlord_id
-- broadly and then scanning for is_active within that set.
create index if not exists idx_tenants_landlord_active on tenants(landlord_id, is_active);

-- The property switcher and per-apartment subscription lookups filter
-- by landlord_id then sort/check status - same reasoning.
create index if not exists idx_properties_landlord_status on properties(landlord_id, subscription_status);

-- Payment-date-range queries (this month's payments, payment history)
-- filter status='completed' then a paid_at range - composite index
-- covers both in one lookup instead of two.
create index if not exists idx_payments_status_paid_at on payments(status, paid_at);

-- First-time credentials and archived-tenant lookups both filter by
-- landlord_id then sort by created_at/left_at - keeps those lists
-- fast as they grow.
create index if not exists idx_first_time_credentials_created on first_time_credentials(landlord_id, created_at desc);
create index if not exists idx_tenants_landlord_left_at on tenants(landlord_id, left_at desc) where is_active = false;

-- New hot path: per-property unit-limit reconciliation and the
-- "Add Unit" capacity check (see unitLimitEnforcement.js /
-- unit.controller.js) both filter units by property_id AND is_frozen
-- together for properties on their own independent subscription
-- clock. idx_units_landlord_frozen already covers the landlord-wide
-- (pooled) case; this covers the per-property case the same way.
create index if not exists idx_units_property_frozen on units(property_id, is_frozen);
