-- =====================================================================
-- BUILD SPEC PHASE 10 - Fix: BA Payout Submission Overwrite Bug
--
-- The bug: submitPaymentDetails() upserted onConflict('cycle_id,ba_id'),
-- so a BA resubmitting through the old per-cycle link silently
-- overwrote their own row - including flipping an already-'paid' row
-- back to 'pending' and dragging it back into the admin's Pending
-- Payments queue. That's a real double-payment risk.
--
-- The fix, per the plan:
--   1. Payment-details capture becomes a ONE-TIME, per-BA action, tied
--      to BA account approval (not a recurring per-cycle link, and not
--      resubmittable through the same channel ever again).
--   2. Payout STATUS (pending/completed per calendar period) is moved
--      out of ba_payment_submissions entirely and into its own table,
--      ba_payouts, so "did this BA submit their M-Pesa details" and
--      "has this BA been paid for period X" are no longer the same
--      row - a resubmission literally has no path to a paid record
--      anymore, because resubmission is removed and even if it existed
--      it wouldn't touch ba_payouts.
--   3. Corrections after the one-time submission go through a
--      separate, admin-issued, 24-hour edit link (ba_payout_edit_links)
--      - never back through the original submission channel.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. brand_ambassadors: the one-time, non-expiring, single-use
--    submission token. Generated once at approval (when the BA account
--    becomes active / they begin work) - see approveBaApplication().
--    payout_submission_used_at is the lock: null = still open, set =
--    permanently closed, no matter how many times the old link is
--    hit afterwards.
-- ---------------------------------------------------------------------
alter table brand_ambassadors
  add column if not exists payout_submission_token text unique,
  add column if not exists payout_submission_token_generated_at timestamptz,
  add column if not exists payout_submission_used_at timestamptz;

create index if not exists idx_brand_ambassadors_payout_submission_token
  on brand_ambassadors(payout_submission_token);

-- Backfill: any existing active/suspended BA without a token yet gets
-- one now, so nobody is left without a submission channel.
update brand_ambassadors
set payout_submission_token = encode(gen_random_bytes(20), 'hex'),
    payout_submission_token_generated_at = now()
where payout_submission_token is null
  and status in ('active', 'suspended');

-- ---------------------------------------------------------------------
-- 2. ba_payment_submissions: repurposed to hold ONE row per BA ever
--    (their on-file M-Pesa/name/email), not one row per (cycle, BA).
--    The old per-cycle uniqueness and NOT NULL cycle_id are dropped;
--    cycle_id is kept only as an informational "which period were they
--    first submitted under" breadcrumb. Payout paid/pending status no
--    longer lives on this table at all (see ba_payouts below) - a
--    'status' value here can never again mean "has been paid".
-- ---------------------------------------------------------------------
alter table ba_payment_submissions
  alter column cycle_id drop not null;

alter table ba_payment_submissions
  drop constraint if exists ba_payment_submissions_cycle_ba_uidx;

alter table ba_payment_submissions
  drop constraint if exists ba_payment_submissions_status_check;

alter table ba_payment_submissions
  add constraint ba_payment_submissions_status_check
  check (status in ('on_file'));

-- One details-row per BA, permanently, going forward.
create unique index if not exists ba_payment_submissions_ba_uidx
  on ba_payment_submissions (ba_id);

-- Existing paid_at/paid_by_admin_id columns on this table are now
-- unused (payout status lives on ba_payouts) - left in place rather
-- than dropped, so no historical data is destroyed by this migration.

-- ---------------------------------------------------------------------
-- 3. ba_payout_edit_links: the ONLY path back into a BA's submitted
--    details after their one-time submission. Admin-issued,
--    expires 24h after issue, single-use.
-- ---------------------------------------------------------------------
create table if not exists ba_payout_edit_links (
  id uuid primary key default gen_random_uuid(),
  ba_id uuid not null references brand_ambassadors(id) on delete cascade,
  token text not null unique,
  created_by_admin_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists idx_ba_payout_edit_links_ba on ba_payout_edit_links(ba_id);
create index if not exists idx_ba_payout_edit_links_token on ba_payout_edit_links(token);

-- ---------------------------------------------------------------------
-- 4. ba_payouts: the actual per-(BA, calendar period) payout status.
--    Decoupled from submission entirely. A 'completed' row is a
--    one-way door - the app layer never updates a 'completed' row's
--    status, and this partial unique index plus the app's "only
--    update WHERE status = 'pending'" pattern (mirroring
--    ba_payout_period_marks' idempotency-ledger pattern above) is the
--    real guarantee that a paid record can't be dragged back to
--    pending.
-- ---------------------------------------------------------------------
create table if not exists ba_payouts (
  id uuid primary key default gen_random_uuid(),
  ba_id uuid not null references brand_ambassadors(id) on delete restrict,
  period_key text not null,                    -- 'YYYY-MM'
  status text not null default 'pending' check (status in ('pending', 'completed')),
  amount numeric,                               -- snapshot, taken at mark-paid time
  paid_at timestamptz,
  paid_by_admin_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ba_payouts_ba_period_uidx unique (ba_id, period_key)
);

create index if not exists idx_ba_payouts_status on ba_payouts(status);
create index if not exists idx_ba_payouts_ba on ba_payouts(ba_id);
create index if not exists idx_ba_payouts_period on ba_payouts(period_key);

drop trigger if exists trg_ba_payouts_updated_at on ba_payouts;
create trigger trg_ba_payouts_updated_at
  before update on ba_payouts
  for each row execute function set_ba_payout_link_updated_at();

-- =====================================================================
-- End of Phase 10 migration.
-- =====================================================================
