-- 2026-08-phase8-ba-rewards-leaderboard.sql
--
-- Premium Redesign Plan - Phase 8: Admin BA Performance & Rewards
-- Dashboard.
--
-- Builds on the existing percentage-commission model (Section E,
-- see 2026-08-section-e-recurring-percentage-commission.sql):
-- payout_rules is already an append-only percentage-rate history per
-- scope (global / ba_override), resolved by "latest effective_from at
-- or before the date in question" (baCommission.service.js's
-- resolveApplicableRate).
--
-- This migration adds exactly what Phase 8 needs on top of that:
--
--   1. payout_rules.effective_until - a reward is TIME-BOUND ("this
--      rate applies for the next 30 days" / a specific date range).
--      NULL means "open-ended" (the existing global-rate / plain
--      override behaviour is completely unaffected - only reward rows
--      ever set this). resolveApplicableRate is updated (in
--      baCommission.service.js, not here) to also require
--      effective_until is null or > the date being resolved, which is
--      what makes the "auto-revert to the universal default, no
--      manual step required" behaviour work: once `now()` passes
--      effective_until, that override row simply stops being picked
--      up, and the BA falls straight back to the global rate.
--
--   2. ba_rewards - one row per reward BATCH (an admin action can
--      reward one or several BAs at once with the same rate/period in
--      a single confirm), plus one row per BA rewarded, so each BA's
--      individual reward is independently listed/counted while still
--      being traceable back to the batch that produced its PDF
--      export. A BA's "reward counter" (Phase 8: "a simple count of
--      how many times that BA has been rewarded to date") is just
--      count(*) of their rows here - no separate counter column to
--      keep in sync.

alter table payout_rules
  add column if not exists effective_until timestamptz;

alter table payout_rules
  add constraint payout_rules_effective_until_after_from
    check (effective_until is null or effective_until > effective_from);

-- Fast "is this override row currently active" lookups, used both by
-- the rate resolver and by the leaderboard's "effective rate" column.
create index if not exists idx_payout_rules_effective_until
  on payout_rules (scope, ba_id, effective_until);

-- ---------------------------------------------------------------------
-- ba_reward_batches - one row per admin "Confirm reward & notify"
-- action (single or bulk). Holds the report PDF metadata so the
-- "download the PDF of who was just rewarded" action always reflects
-- exactly that batch, not a recomputed/rebuilt list.
-- ---------------------------------------------------------------------
create table if not exists ba_reward_batches (
  id uuid primary key default gen_random_uuid(),
  new_percentage numeric(5,2) not null check (new_percentage >= 0 and new_percentage <= 100),
  default_percentage_at_time numeric(5,2) not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  ba_count integer not null default 0,
  created_by_admin_id text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- ba_rewards - one row per BA per batch. previous_percentage is
-- whatever effective rate that BA had a moment before this reward was
-- confirmed (their own override, or the global default if they had
-- none) - shown on the leaderboard/history as "was X%, rewarded to Y%".
-- ---------------------------------------------------------------------
create table if not exists ba_rewards (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references ba_reward_batches(id) on delete cascade,
  ba_id uuid not null references brand_ambassadors(id) on delete cascade,
  payout_rule_id uuid references payout_rules(id) on delete set null,

  previous_percentage numeric(5,2),
  new_percentage numeric(5,2) not null,
  start_at timestamptz not null,
  end_at timestamptz not null,

  created_by_admin_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ba_rewards_ba on ba_rewards (ba_id, created_at desc);
create index if not exists idx_ba_rewards_batch on ba_rewards (batch_id);
-- Powers "prioritize BAs who have not yet been rewarded" on the
-- leaderboard (a cheap NOT EXISTS / left-join-is-null check) and the
-- per-BA reward counter (count(*) grouped by ba_id).
create index if not exists idx_ba_rewards_ba_only on ba_rewards (ba_id);
