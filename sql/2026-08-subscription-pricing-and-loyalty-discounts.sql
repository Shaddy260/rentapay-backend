-- 2026-08-subscription-pricing-and-loyalty-discounts.sql
--
-- Lets an admin change the per-unit subscription fee and the
-- period-length discount tiers (previously hardcoded in
-- src/utils/pricing.js), the same way commission percentages are
-- already admin-editable via payout_rules. A change here affects
-- EVERY place the fee is calculated: landlord signup, adding a
-- property, add-units mid-period, and renewing/managing a
-- subscription - because all of those call the single
-- calculateSubscriptionCost() helper, which now reads its rate from
-- this table instead of a constant.
--
-- Also adds a loyalty-discount system: the platform auto-detects
-- landlords who have paid for consecutive subscription periods
-- (default threshold: 4 months running, no gap), and an admin can
-- bulk-grant a discount percentage to some or all of them from a
-- dedicated UI. A granted discount is stored per landlord and is
-- automatically re-applied on their NEXT subscription charge
-- (signup is exempt - a brand-new account can't yet be "consecutive").

-- ---------------------------------------------------------------------
-- 1. subscription_pricing_settings - append-only history, same pattern
--    as payout_rules: setting a new rate never overwrites the old one,
--    it inserts a new row with its own effective_from. The row with
--    the latest effective_from <= now is the one currently in force.
-- ---------------------------------------------------------------------
create table if not exists subscription_pricing_settings (
  id uuid primary key default gen_random_uuid(),

  base_rate_per_unit_per_month numeric(12,2) not null check (base_rate_per_unit_per_month >= 0),

  -- Period-length discount tiers, e.g. {"3": 0.05, "6": 0.10, "12": 0.15}.
  -- Keys are "minimum whole months", values are a fraction off the
  -- base rate (0.10 = 10% off). 1-month tier is implicitly 0 unless
  -- explicitly included.
  period_discounts jsonb not null default '{"3": 0.05, "6": 0.10, "12": 0.15}'::jsonb,

  effective_from timestamptz not null default now(),
  set_by_admin_id text,
  note text,

  created_at timestamptz not null default now()
);

create index if not exists idx_sub_pricing_effective on subscription_pricing_settings(effective_from desc);

-- Seed one row matching the previous hardcoded values, so existing
-- environments keep charging exactly what they charge today until an
-- admin changes it.
insert into subscription_pricing_settings (base_rate_per_unit_per_month, period_discounts, effective_from, set_by_admin_id, note)
select 50, '{"3": 0.05, "6": 0.10, "12": 0.15}'::jsonb, now(), 'system', 'Initial value migrated from the old hardcoded constant.'
where not exists (select 1 from subscription_pricing_settings);

-- ---------------------------------------------------------------------
-- 2. landlord_loyalty_discounts - a discount grant for one landlord.
--    Only one row can be ACTIVE per landlord at a time (enforced in
--    application code, not a DB constraint, so history is kept: a
--    landlord can be granted a new discount later that supersedes an
--    old one, and the old row stays for audit purposes).
-- ---------------------------------------------------------------------
create table if not exists landlord_loyalty_discounts (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,

  discount_percentage numeric(5,2) not null check (discount_percentage >= 0 and discount_percentage <= 100),

  -- How many consecutive months of subscription this landlord had
  -- when the discount was granted - shown back to the admin, and
  -- used to avoid re-flagging the same landlord in the "candidates"
  -- list until they've clocked up more months since the last grant.
  consecutive_months_at_grant int not null default 0,

  -- Bulk grants share a batch id so the admin UI can show "granted
  -- together" and the whole batch can be looked up/audited as one.
  batch_id uuid,

  is_active boolean not null default true,
  note text,

  granted_by_admin_id text,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by_admin_id text
);

create index if not exists idx_loyalty_discount_landlord on landlord_loyalty_discounts(landlord_id);
create index if not exists idx_loyalty_discount_active on landlord_loyalty_discounts(landlord_id, is_active) where is_active = true;
create index if not exists idx_loyalty_discount_batch on landlord_loyalty_discounts(batch_id);

-- Only one active discount per landlord at a time.
create unique index if not exists uniq_loyalty_discount_active_landlord
  on landlord_loyalty_discounts(landlord_id)
  where is_active = true;
