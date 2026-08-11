-- 2026-08-ba-percentage-commission-model.sql
--
-- ITEM 13 - Move from fixed-price BA commission to a percentage-based
-- model.
--
-- Today payout_rules.amount (flat KES) / unit_pricing_tiers (KES per
-- unit-count bracket) are the only ways to price a BA's BASE payout
-- per qualifying landlord - both are fixed-price. commission_tiers is
-- already percentage-based, but it's a separate milestone BONUS layered
-- on top of that base, not the base itself.
--
-- This adds a per-scope (global / ba_override, same pattern as
-- payout_rules/commission_tiers/unit_pricing_tiers) toggle on
-- payout_rules: commission_model = 'fixed' (unchanged default
-- behaviour - amount / unit_pricing_tiers as before) or 'percentage'
-- (the BA instead earns percentage_rate% of the landlord's qualifying
-- subscription payment amount - i.e. what the landlord actually paid
-- RentaPay for the period that made them qualify - rather than one
-- flat number). unit_pricing_tiers is deliberately left untouched and
-- still fully configurable even while a scope is set to 'percentage' -
-- it's simply not applied while that model is selected, so switching
-- back to 'fixed' later needs no re-entry. This is the "keep both
-- models available, admin chooses" option the spec itself flagged as
-- the safer path pending a firm decision, rather than a destructive
-- hard cutover.

alter table payout_rules
  add column if not exists commission_model text not null default 'fixed'
    check (commission_model in ('fixed', 'percentage')),
  add column if not exists percentage_rate numeric(5,2);

alter table payout_rules
  add constraint payout_rules_percentage_rate_required
    check (
      (commission_model = 'fixed')
      or (commission_model = 'percentage' and percentage_rate is not null and percentage_rate >= 0 and percentage_rate <= 100)
    );

-- Snapshot of exactly how a claim's BASE payout_amount was computed
-- when commission_model = 'percentage' at qualification time - same
-- "write once, never recompute at read time" convention as
-- unit_pricing_tier_id/commission_tier_id, so a later rate change
-- never retroactively changes a historical claim's own numbers.
-- basis_amount is the landlord's qualifying subscription_payments.amount
-- the percentage was actually calculated from.
alter table ba_landlord_claims
  add column if not exists payout_commission_model text check (payout_commission_model in ('fixed', 'percentage')),
  add column if not exists payout_percentage_rate numeric(5,2),
  add column if not exists payout_basis_amount numeric(12,2);

-- Backfill: every claim that already has a payout_amount was computed
-- under the (only, at the time) fixed model.
update ba_landlord_claims
  set payout_commission_model = 'fixed'
  where payout_amount is not null and payout_commission_model is null;
