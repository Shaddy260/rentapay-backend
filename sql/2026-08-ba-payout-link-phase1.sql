-- =====================================================================
-- BA Monthly Payment Details & Payout Workflow - Phase 1
--
-- Data model + monthly cycle lifecycle. See
-- ba-payout-link-plan.md for the full build plan (Phases 1-4).
--
-- Two tables:
--   ba_payout_link_cycles     - one row per calendar month; holds the
--                                public submission token for that month.
--   ba_payment_submissions    - one row per (cycle, BA); the BA's
--                                submitted M-Pesa/name/email for that
--                                cycle's earnings. Resubmission within
--                                the same month overwrites (see the
--                                unique constraint below), so this
--                                table never accumulates a history of
--                                prior mistaken entries.
--
-- Cycles are keyed by period_key ('YYYY-MM'), calendar-month, no
-- expiry - a cycle simply becomes 'closed' once its month ends; that
-- flag is informational only and never removes or blocks access to
-- unpaid cards still sitting inside it (Phase 3 reads across ALL
-- cycles with unpaid entries, not just the active one).
-- =====================================================================

create table if not exists ba_payout_link_cycles (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  period_key text not null unique,           -- 'YYYY-MM', one cycle per calendar month
  generated_by_admin_id text,
  generated_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ba_payout_link_cycles_status_idx
  on ba_payout_link_cycles (status);

create table if not exists ba_payment_submissions (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references ba_payout_link_cycles(id) on delete restrict,
  ba_id uuid not null references brand_ambassadors(id) on delete restrict,
  mpesa_number text not null,
  submitted_name text not null,
  submitted_email text not null,
  submitted_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'paid')),
  paid_at timestamptz,
  paid_by_admin_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Resubmission overwrites the existing row for this (cycle, ba)
  -- rather than inserting a new one - enforced here, applied via
  -- upsert on the write path in Phase 2.
  constraint ba_payment_submissions_cycle_ba_uidx unique (cycle_id, ba_id)
);

create index if not exists ba_payment_submissions_status_idx
  on ba_payment_submissions (status);
create index if not exists ba_payment_submissions_ba_idx
  on ba_payment_submissions (ba_id);
create index if not exists ba_payment_submissions_email_idx
  on ba_payment_submissions (lower(submitted_email));

-- ---------------------------------------------------------------------
-- updated_at maintenance - same trigger convention used elsewhere in
-- this codebase (see schema.sql) rather than touching it manually in
-- every service function.
-- ---------------------------------------------------------------------
create or replace function set_ba_payout_link_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_ba_payout_link_cycles_updated_at on ba_payout_link_cycles;
create trigger trg_ba_payout_link_cycles_updated_at
  before update on ba_payout_link_cycles
  for each row execute function set_ba_payout_link_updated_at();

drop trigger if exists trg_ba_payment_submissions_updated_at on ba_payment_submissions;
create trigger trg_ba_payment_submissions_updated_at
  before update on ba_payment_submissions
  for each row execute function set_ba_payout_link_updated_at();

-- =====================================================================
-- End of Phase 1 migration.
-- =====================================================================
