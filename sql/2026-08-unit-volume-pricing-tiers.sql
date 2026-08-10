-- 2026-08-unit-volume-pricing-tiers.sql
--
-- BA Portal fixes spec, item 10 - Pricing/commission structure needs
-- volume-based tiers.
--
-- Adds a bracket-based "unit_pricing_tiers" table so the BASE payout
-- per qualifying landlord can scale with how many subscribed units
-- that landlord has (1-5 units = X, 6-15 = Y, 16+ = Z, etc.) instead
-- of always paying the single flat payout_rules.amount. Follows the
-- exact same scope pattern already used by commission_tiers and
-- payout_rules: a 'global' ladder that applies to every BA by
-- default, plus an optional 'ba_override' ladder for a specific BA -
-- same admin screen, same "scope" dropdown.
--
-- payout_rules.amount is KEPT as the fallback base amount for when no
-- unit_pricing_tiers ladder is configured at all (fresh install, or
-- admin hasn't set one up yet) - never removed, never made required.
--
-- How the two systems combine (per spec): the qualification job picks
-- the base payout from whichever unit bracket the landlord's unit
-- count falls into (or payout_rules.amount if no bracket matches/is
-- configured), and the existing commission-tier percent is applied ON
-- TOP of that resolved base amount - so a BA who both exceeded their
-- target AND onboarded a big landlord gets both effects at once, not
-- just one.

create table if not exists unit_pricing_tiers (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global', 'ba_override')),
  ba_id uuid references brand_ambassadors(id) on delete cascade,

  -- Inclusive lower bound. Inclusive upper bound, or NULL for "and up"
  -- (e.g. 16+ units). Enforced non-overlapping per scope/ba_id at the
  -- application layer (payoutRules.controller.js validateUnitLadder),
  -- same as commission_tiers' duplicate-target check.
  min_units int not null,
  max_units int, -- null = unbounded ("this bracket and above")

  amount numeric not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint unit_pricing_tiers_ba_id_requires_override
    check ((scope = 'ba_override' and ba_id is not null) or (scope = 'global' and ba_id is null)),
  constraint unit_pricing_tiers_min_units_positive check (min_units >= 1),
  constraint unit_pricing_tiers_max_gte_min check (max_units is null or max_units >= min_units),
  constraint unit_pricing_tiers_amount_non_negative check (amount >= 0)
);

create index if not exists idx_unit_pricing_tiers_scope on unit_pricing_tiers(scope, ba_id, min_units);

-- Snapshot of which unit bracket (if any) was used to compute a
-- claim's payout_amount at qualification time - same "write once,
-- never recompute at read time" convention as commission_tier_id.
-- ON DELETE SET NULL: removing/editing a bracket later must never
-- retroactively change a historical claim's own payout_amount
-- snapshot, only lose the "which row explains it" pointer.
alter table ba_landlord_claims
  add column if not exists unit_pricing_tier_id uuid references unit_pricing_tiers(id) on delete set null;

-- Snapshot of the landlord's unit count AT qualification time, purely
-- for the BA-facing "why was I paid this" breakdown (item 10's
-- transparency requirement) - so that breakdown stays accurate even
-- if the landlord adds/removes units afterward.
alter table ba_landlord_claims
  add column if not exists qualified_unit_count int;

create index if not exists idx_ba_landlord_claims_unit_pricing_tier on ba_landlord_claims(unit_pricing_tier_id);
