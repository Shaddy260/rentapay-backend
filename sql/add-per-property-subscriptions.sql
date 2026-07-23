-- =====================================================================
-- Direct request: "if a landlord has added other apartments, each
-- apartment he shifts to should show their own subscription period...
-- if one expires and he logs in he should subscribe to it
-- differently... every apartment should specifically show the number
-- of units he paid for - under no circumstance should they show the
-- same number."
--
-- Before this, EVERY property a landlord owns shared one pooled
-- unit_limit and one shared subscription_expires_at on the landlords
-- row - buying a second property just added its units count onto the
-- same landlord-wide total and rode the same expiry clock as
-- everything else. That's structurally why apartments could never
-- show different numbers.
--
-- Scope of this change: the landlord's ORIGINAL/first property (set
-- up during initial registration, before any property even exists as
-- its own row) keeps using the landlords-row fields exactly as before
-- - nothing about day-one signup changes. Every property bought
-- afterwards via property_payments (the "add another apartment" flow)
-- now gets its OWN subscription_expires_at/period/unit_limit/status,
-- independent of every other property on the account.
-- =====================================================================

alter table properties add column if not exists unit_limit int;
alter table properties add column if not exists subscription_period_months int;
alter table properties add column if not exists subscription_started_at timestamptz;
alter table properties add column if not exists subscription_expires_at timestamptz;
alter table properties add column if not exists subscription_status text
  check (subscription_status in ('active', 'expired')) default 'active';

-- Existing properties (created before this migration) were riding on
-- the landlord's pooled clock - backfill them from their landlord's
-- current values so nothing suddenly looks unpaid/expired the moment
-- this migration runs. New properties purchased from here on get
-- their own real value written in completePropertyPurchase instead of
-- this fallback.
update properties p
set
  unit_limit = coalesce(p.unit_limit, (select l.unit_limit from landlords l where l.id = p.landlord_id)),
  subscription_period_months = coalesce(p.subscription_period_months, (select l.subscription_period_months from landlords l where l.id = p.landlord_id)),
  subscription_started_at = coalesce(p.subscription_started_at, (select l.subscription_started_at from landlords l where l.id = p.landlord_id)),
  subscription_expires_at = coalesce(p.subscription_expires_at, (select l.subscription_expires_at from landlords l where l.id = p.landlord_id)),
  subscription_status = case when (select l.subscription_status from landlords l where l.id = p.landlord_id) = 'active' then 'active' else 'expired' end
where p.unit_limit is null;

-- Track which property a given property_payments / subscription_payments
-- row is for, so the Daraja callback knows which property's clock to
-- update rather than always touching the landlord's pooled fields.
alter table property_payments add column if not exists renews_property_id uuid references properties(id);

-- Direct request: "don't fix the subscription period, let the
-- landlord enter their own subscription time they wish" - this is the
-- landlord's freely-chosen number of months for THIS purchase
-- (new property, or later a renewal of an existing one), instead of
-- inferring it from whatever happened to be left on a shared clock.
alter table property_payments add column if not exists period_months int default 1;
