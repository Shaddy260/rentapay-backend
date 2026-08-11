-- =====================================================================
-- Consolidated Change Instructions - Section E
--
-- Replaces the fixed-price / one-time BA commission model with a
-- RECURRING PERCENTAGE-OF-PAYMENT model. Hard cutover - not kept
-- alongside the old model, per the spec ("hard cutover, not kept
-- alongside the new model").
--
-- Removes:
--   - commission_tiers table (the fixed-ladder milestone-bonus table)
--     and everything built on it.
--   - unit_pricing_tiers table (bracket-based fixed BASE payout by
--     unit count) - this was the other half of the fixed-price model
--     Section E replaces; it makes no sense once the base itself is a
--     recurring percentage of the actual payment rather than a flat
--     number to scale.
--   - The two half-built 'fixed' / 'percentage' toggle columns added
--     to payout_rules by the (now superseded) prior addendum
--     (commission_model, percentage_rate) - payout_rules becomes a
--     pure percentage store, not a toggle.
--   - payout_rules.amount / required_consecutive_months / min_units -
--     these belonged entirely to the fixed model and the "qualifying
--     purchase" gate, which is Section C's job now (landlords.
--     ba_qualification_status / ba_qualified_at), not payout_rules'.
--
-- Adds:
--   - payout_rules becomes an append-only PERCENTAGE HISTORY: each row
--     is (scope, ba_id, percentage, effective_from). Setting a new
--     rate INSERTS a new row rather than overwriting the current one,
--     so history is preserved and the rate applied to any given
--     payment = whichever row has the latest effective_from at or
--     before that payment's paid_at (see resolution helper in
--     baCommission.service.js).
--   - ba_commission_earnings: one row per completed landlord
--     subscription payment that a qualified landlord's BA earns
--     commission on - written by the payment-processing path
--     (processSubscriptionPaymentCallback in payment.controller.js),
--     not by a periodic payout job. This is the per-payment,
--     recurring-for-as-long-as-they-stay-subscribed record Section E
--     calls for, replacing the old "single payout row written once at
--     qualification" shape entirely.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Drop the fixed-price milestone/bracket tables entirely (hard
--    cutover - no admin UI or job should read these again).
-- ---------------------------------------------------------------------
drop table if exists commission_tiers cascade;
drop table if exists unit_pricing_tiers cascade;

-- ---------------------------------------------------------------------
-- 2. Rebuild payout_rules as a pure, append-only percentage-rate
--    history. Existing rows/columns from the fixed model and the
--    half-built fixed/percentage toggle are dropped; a fresh row is
--    seeded so the system has *some* rate to resolve against
--    immediately (admin should review/change it right away via the
--    new Pricing & Commission panel).
-- ---------------------------------------------------------------------
alter table payout_rules drop constraint if exists payout_rules_percentage_rate_required;
alter table payout_rules drop constraint if exists payout_rules_ba_id_requires_override;
drop index if exists payout_rules_single_global_uidx;
drop index if exists payout_rules_one_per_ba_override_uidx;

alter table payout_rules drop column if exists amount;
alter table payout_rules drop column if exists required_consecutive_months;
alter table payout_rules drop column if exists min_units;
alter table payout_rules drop column if exists commission_model;
alter table payout_rules drop column if exists percentage_rate;

-- HARD CUTOVER: any rows still in the table at this point were written
-- under the old fixed-price model and have no percentage value (that's
-- exactly the column being added below) - there is no valid amount to
-- carry forward for them (a flat KES figure has no meaningful
-- percentage-of-payment equivalent), so they're cleared rather than
-- backfilled. This is what the seed insert further down replaces with
-- a fresh, real percentage rate.
delete from payout_rules;

alter table payout_rules add column if not exists percentage numeric(5,2);
alter table payout_rules add column if not exists effective_from timestamptz not null default now();
alter table payout_rules add column if not exists set_by_admin_id text;

alter table payout_rules alter column percentage set not null;

alter table payout_rules
  add constraint payout_rules_percentage_range
    check (percentage >= 0 and percentage <= 100);

alter table payout_rules
  add constraint payout_rules_ba_id_requires_override
    check ((scope = 'ba_override' and ba_id is not null) or (scope = 'global' and ba_id is null));

-- A scope/ba_id pair may have many rows over time (history) but never
-- two rows with the exact same effective_from - that would make rate
-- resolution ambiguous for a payment paid at that exact instant.
create unique index if not exists payout_rules_scope_effective_uidx
  on payout_rules (scope, coalesce(ba_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from);

-- Fast "latest row at or before this payment's paid_at" lookups -
-- exactly the query baCommission.service.js's rate resolver runs.
create index if not exists idx_payout_rules_scope_ba_effective
  on payout_rules (scope, ba_id, effective_from desc);

-- Seed ONE global rate row if the table is now empty (e.g. fresh
-- install, or every row above got dropped/cleared) - 5%, effective
-- immediately, so the system always has a rate to resolve. Admin
-- should review/change this via PATCH /api/brand-ambassadors/
-- payout-rules/global right after this migration runs.
insert into payout_rules (scope, ba_id, percentage, effective_from)
select 'global', null, 5, now()
where not exists (select 1 from payout_rules where scope = 'global');

-- ---------------------------------------------------------------------
-- 3. ba_commission_earnings - one row per completed landlord
--    subscription payment a BA earns recurring commission on.
-- ---------------------------------------------------------------------
create table if not exists ba_commission_earnings (
  id uuid primary key default gen_random_uuid(),

  ba_id uuid not null references brand_ambassadors(id) on delete cascade,

  -- ON DELETE SET NULL (not cascade), matching the money-integrity
  -- convention used elsewhere in this schema (see
  -- add-brand-ambassador-role.sql) - deleting a landlord account must
  -- never silently erase earned-commission history.
  landlord_id uuid references landlords(id) on delete set null,

  -- One earnings row per subscription payment, enforced below - makes
  -- computing/recording commission from the payment-processing path
  -- idempotent no matter how many times it's (re-)invoked for the
  -- same payment (retries, webhook re-delivery, etc.).
  subscription_payment_id uuid not null references subscription_payments(id) on delete cascade,

  -- Snapshot of exactly what produced commission_amount - never
  -- recomputed at read time, so a later rate change never
  -- retroactively changes a historical row's own numbers (same
  -- write-once convention as payout_amount used to be on
  -- ba_landlord_claims).
  payment_amount numeric(12,2) not null,
  percentage_applied numeric(5,2) not null,
  commission_amount numeric(12,2) not null,
  payout_rule_id uuid references payout_rules(id) on delete set null,

  -- Billing cycle this payment's commission belongs to, e.g.
  -- '2026-08' - derived from the payment's own paid_at at write time.
  -- This is what Section F's Payout Run groups/filters by.
  billing_cycle text not null,
  paid_at timestamptz not null,

  created_at timestamptz not null default now()
);

create unique index if not exists ba_commission_earnings_payment_uidx
  on ba_commission_earnings (subscription_payment_id);

create index if not exists idx_ba_commission_earnings_ba_cycle
  on ba_commission_earnings (ba_id, billing_cycle);
create index if not exists idx_ba_commission_earnings_landlord
  on ba_commission_earnings (landlord_id);

-- =====================================================================
-- End of Section E migration. After this runs:
--   - commission_tiers and unit_pricing_tiers no longer exist.
--   - payout_rules holds a percentage-rate HISTORY per scope
--     (global / ba_override), resolved by effective_from.
--   - ba_commission_earnings is the new source of truth for what a BA
--     has actually earned, one row per completed landlord subscription
--     payment - Sections F (Payout Run) and G (PDF export), not part
--     of this migration, should be rebuilt to read from this table
--     instead of the dropped ba_landlord_claims.payout_amount.
-- =====================================================================
