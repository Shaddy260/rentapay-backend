-- =====================================================================
-- BUILD SPEC PHASE 11 - Admin: Payout Review, Reconciliation &
-- Cross-BA Security Report.
--
-- What THIS migration adds:
--   1. ba_payout_period_marks - the idempotency ledger for "Mark as
--      Paid" (Part A #2). A unique constraint on (ba_id, period_type,
--      period_key) is the real guarantee that a double-click or retry
--      can never double-count a period's payout - the controller
--      upserts against this row rather than blindly re-updating
--      claims, same "DB constraint is the real safety net, app check
--      is a UX nicety" pattern already used for BA phone/email
--      uniqueness (see add-brand-ambassador-role.sql).
--   2. ba_landlord_claims.match_status widened to include 'conflict' -
--      Part C's duplicatePhoneAttempts signal needs a real row to
--      point to for a rejected/conflicting submission (a second BA
--      trying to claim a landlord already tied to someone else), not
--      just a 409 that vanishes. submitLandlordClaim now inserts this
--      row before returning the conflict response, so that attempt's
--      history survives for the security report - see build spec:
--      "track attempted conflicts, not just the winning claim, so
--      this history isn't lost."
--   3. Supporting indexes for the new period-range and dispute-flag
--      lookups this phase's reads run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ba_payout_period_marks
-- ---------------------------------------------------------------------
create table if not exists ba_payout_period_marks (
  id uuid primary key default gen_random_uuid(),
  ba_id uuid not null references brand_ambassadors(id) on delete cascade,

  period_type text not null check (period_type in ('week', 'month')),
  -- 'month' -> 'YYYY-MM'; 'week' -> the Monday-start date of that week
  -- as 'YYYY-MM-DD', matching brandAmbassador.controller.js's existing
  -- weekKey()/monthKey() convention (Phase 5 stats) so period keys are
  -- consistent app-wide.
  period_key text not null,

  status text not null default 'paid' check (status in ('paid', 'not_paid')),

  -- Snapshot of exactly which claims this mark covers and what it
  -- totalled at the time - read-only history, same write-once-
  -- snapshot rule as payout_amount/commission_bonus_amount on
  -- ba_landlord_claims itself (see Money & Data Integrity Rules).
  claim_ids uuid[] not null default '{}',
  base_total numeric not null default 0,
  commission_total numeric not null default 0,
  grand_total numeric not null default 0,

  marked_paid_by text,
  marked_paid_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- THE guarantee: one mark per BA per period. markBaPeriodPaid upserts
-- against this row (insert, or update if a not_paid mark already
-- exists for this period) - a retry/double-click that hits this
-- constraint on insert is treated as already-handled, never as a
-- second payout.
create unique index if not exists ba_payout_period_marks_unique_period
  on ba_payout_period_marks (ba_id, period_type, period_key);

create index if not exists idx_ba_payout_period_marks_ba on ba_payout_period_marks(ba_id, period_type);

-- ---------------------------------------------------------------------
-- 2. ba_landlord_claims.match_status: allow 'conflict'
-- ---------------------------------------------------------------------
alter table ba_landlord_claims drop constraint if exists ba_landlord_claims_match_status_check;
alter table ba_landlord_claims add constraint ba_landlord_claims_match_status_check
  check (match_status in ('unmatched', 'matched', 'conflict'));

-- ---------------------------------------------------------------------
-- 3. Supporting indexes
-- ---------------------------------------------------------------------
-- Payout Review (Part A) and the statement download group/filter by
-- qualified_at range per BA - qualification_status is already indexed
-- (Phase 1) but not paired with the date range.
create index if not exists idx_ba_landlord_claims_qualified_at on ba_landlord_claims(qualified_at);

-- Cross-BA security report (Part C) scans by submitted_phone across
-- ALL BAs for duplicate-attempt detection - submitted_phone is already
-- indexed (Phase 1); this adds the created_at pairing rapid-fire
-- detection and the report's rolling window both rely on.
create index if not exists idx_ba_landlord_claims_created_at on ba_landlord_claims(created_at);

-- disputedAttributions signal filters landlords by this flag.
create index if not exists idx_landlords_ba_attribution_disputed
  on landlords(ba_attribution_disputed) where ba_attribution_disputed = true;

-- =====================================================================
-- End of Phase 11 migration.
-- =====================================================================
