-- =====================================================================
-- BRAND AMBASSADOR (BA) ROLE - PHASE 1: ROLES, DATA MODEL & MIGRATIONS
--
-- Adds a new, paid "brand_ambassador" role alongside admin / landlord /
-- manager / tenant. A BA logs field claims ("I onboarded this
-- landlord") which the system verifies against the landlord's own real
-- registration - a BA never creates a landlord account directly.
--
-- Tables added:
--   1. brand_ambassadors      - the BA account itself (self-fill +
--                                admin-approval, see Phase 2)
--   2. ba_landlord_claims     - a BA's logged/matched landlord claims,
--                                with payout snapshots
--   3. landlord_leads         - unverified marketing self-fill leads
--                                (Phase 9), kept separate from claims
--   4. payout_rules           - global + per-BA payout amount/threshold
--   5. commission_tiers       - milestone commission ladder
--
-- Plus: landlords.ba_id / ba_attribution_disputed(_at).
--
-- NOTE: this codebase has no `admins` table - admin auth is a single
-- env-based credential and admin.controller.js signs its JWT with the
-- literal id 'super-admin' (see auth.controller.js adminLogin). Admin-
-- attribution columns below (reviewed_by_admin_id, marked_paid_by,
-- etc.) are therefore plain `text`, not foreign keys, matching how
-- actor_type/actor_id are stored as text in activity_logs.
--
-- MONEY & DATA INTEGRITY RULES baked into this schema (see build spec):
--   - matched_landlord_id uses ON DELETE SET NULL, never cascade/block,
--     so deleting a landlord can never silently erase payout history -
--     submitted_name/phone/location snapshots on the claim survive it.
--   - payout_amount / commission_bonus_amount are write-once snapshots
--     at qualification time - nothing should ever recompute them from
--     the live payout_rules/commission_tiers rows at read time.
--   - Partial unique indexes (excluding 'rejected') are the real
--     concurrency safety net for BA phone/email uniqueness - the
--     application-level check in the controller is a fast-fail UX
--     nicety on top of this, not the guarantee itself.
--   - A unique constraint on (ba_id, period) for PAID claims (added at
--     the payout-marking table in Phase 11) will make "mark as paid"
--     idempotent - not needed on this table itself, since qualification
--     and paid-marking happen at the individual-claim level here, but
--     is called out for anyone building Phase 11 against this schema.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. brand_ambassadors
-- ---------------------------------------------------------------------
create table if not exists brand_ambassadors (
  id uuid primary key default gen_random_uuid(),

  -- Human-facing Agent/BA ID. Assigned ONLY on admin approval (Phase 2)
  -- so a rejected/pending row never occupies a real code.
  ba_code text unique,

  -- Assigned at the same moment as ba_code, on approval. Reuses the
  -- ba_code value itself (e.g. both "BA-0042") - this is the value
  -- appended to the public signup link as ?ref=BA-0042.
  referral_code text unique,

  full_name text not null,
  email text not null,
  phone text not null,

  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'active', 'rejected', 'suspended', 'inactive')),
  -- NOTE: no per-record 'pending_onboarding' token state - the
  -- onboarding link itself is generic (Phase 2). 'inactive' is a
  -- distinct, permanent offboarded state (Phase 16) - never conflate
  -- it with 'suspended', which is reversible and blocks future
  -- activity only, per the Money & Data Integrity Rules.

  email_verified boolean not null default false,
  email_verification_code text,
  email_verification_expires_at timestamptz,

  must_change_password boolean not null default true,
  password_hash text,

  rejected_reason text,
  reviewed_by_admin_id text,
  reviewed_at timestamptz,

  -- Set when the "pending too long" reminder job (Phase 2) notifies
  -- admin about this application, so it isn't re-notified every run.
  reminder_sent_at timestamptz,

  -- Per-BA overrides of the global payout_rules row.
  payout_rate_override numeric,
  min_months_override int,
  min_units_override int,

  -- The commission percentage this BA has actually earned by crossing
  -- a tier threshold (see commission_tiers, Phase 10).
  current_commission_percent numeric not null default 0,

  -- Null here since the BA creates their own row now (Phase 2) - kept
  -- for schema compatibility with anything that expects it.
  created_by_admin_id text,

  terms_accepted_at timestamptz,
  terms_version text,

  leaderboard_opt_in boolean not null default false,

  offboarded_at timestamptz,
  offboarded_by_admin_id text,

  onboarded_at timestamptz, -- set on approval, not on submission
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- CONCURRENCY: the real safety net against two near-simultaneous
-- submissions with the same phone/email - excludes 'rejected' rows so
-- a rejected applicant can cleanly re-apply later without a false
-- "already exists" error against their own old row. Any application-
-- level uniqueness check (submitBaOnboarding, Phase 2) must apply the
-- same "excluding rejected" logic to match this index's behavior.
create unique index if not exists brand_ambassadors_phone_active_uidx
  on brand_ambassadors (phone) where status <> 'rejected';
create unique index if not exists brand_ambassadors_email_active_uidx
  on brand_ambassadors (lower(email)) where status <> 'rejected';

create index if not exists idx_brand_ambassadors_status on brand_ambassadors(status);

-- ---------------------------------------------------------------------
-- 2. ba_landlord_claims
-- ---------------------------------------------------------------------
create table if not exists ba_landlord_claims (
  id uuid primary key default gen_random_uuid(),
  ba_id uuid not null references brand_ambassadors(id) on delete cascade,

  -- Raw text as the BA typed it, kept even after matching for audit.
  submitted_name text not null,
  submitted_phone text not null,
  submitted_location text,

  match_status text not null default 'unmatched'
    check (match_status in ('unmatched', 'matched')),

  -- ON DELETE SET NULL (not cascade, not restrict): deleting a
  -- landlord account must never break payout history. The
  -- submitted_* snapshot above plus this claim row itself (with its
  -- own qualification_status/payout_amount) survive the landlord
  -- account being removed later.
  matched_landlord_id uuid references landlords(id) on delete set null,
  matched_at timestamptz,

  qualification_status text not null default 'pending'
    check (qualification_status in ('pending', 'qualified', 'paid', 'not_paid')),
  qualified_at timestamptz,

  -- Snapshot of the BASE amount owed at qualification time - later
  -- rate changes must never retroactively change this. Read-only once
  -- written; never recompute from current payout_rules at read time.
  payout_amount numeric,

  -- Snapshot of any milestone-commission bonus applied on top of
  -- payout_amount at qualification time. Rounding (to the nearest
  -- shilling) happens exactly once, at the point this is written in
  -- the qualification job - never re-rounded anywhere else.
  commission_bonus_amount numeric default 0,
  commission_tier_id uuid, -- fk added below, after commission_tiers exists

  marked_paid_by text,
  marked_paid_at timestamptz,

  -- Every edit to submitted_name/phone/location after initial
  -- creation: [{editedAt, editedField, oldValue, newValue}, ...].
  -- Powers the admin reconciliation tool (Phase 11).
  edit_history jsonb not null default '[]'::jsonb,

  -- True if this landlord's account was already tagged with this
  -- ba_id at registration time via the referral link (Phase 4) - i.e.
  -- the match was instant/automatic rather than found via phone
  -- lookup after the fact. A claim that is NOT referred-at-signup but
  -- still matches is worth a slightly closer look (security report,
  -- Phase 11).
  referred_at_signup boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ba_landlord_claims_ba on ba_landlord_claims(ba_id, created_at desc);
create index if not exists idx_ba_landlord_claims_matched_landlord on ba_landlord_claims(matched_landlord_id);
create index if not exists idx_ba_landlord_claims_qualification on ba_landlord_claims(qualification_status);
create index if not exists idx_ba_landlord_claims_submitted_phone on ba_landlord_claims(submitted_phone);

-- ---------------------------------------------------------------------
-- 3. landlord_leads (unverified marketing self-fill, Phase 9)
-- ---------------------------------------------------------------------
create table if not exists landlord_leads (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null,
  house_name text,
  location text,
  source text not null check (source in ('marketing_link', 'agent_link')),
  status text not null default 'new' check (status in ('new', 'contacted', 'converted')),
  converted_landlord_id uuid references landlords(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_landlord_leads_status on landlord_leads(status);

-- ---------------------------------------------------------------------
-- 4. payout_rules
-- ---------------------------------------------------------------------
create table if not exists payout_rules (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global', 'ba_override')),
  ba_id uuid references brand_ambassadors(id) on delete cascade,
  amount numeric not null,
  required_consecutive_months int not null default 2,
  min_units int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_rules_ba_id_requires_override
    check ((scope = 'ba_override' and ba_id is not null) or (scope = 'global' and ba_id is null))
);

-- Only one active 'global' row should ever exist - enforced in the
-- controller (application layer), but this index also prevents two
-- global rows from ever coexisting at the DB level.
create unique index if not exists payout_rules_single_global_uidx
  on payout_rules ((scope)) where scope = 'global';
create unique index if not exists payout_rules_one_per_ba_override_uidx
  on payout_rules (ba_id) where scope = 'ba_override';

-- ---------------------------------------------------------------------
-- 5. commission_tiers
-- ---------------------------------------------------------------------
create table if not exists commission_tiers (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global', 'ba_override')),
  ba_id uuid references brand_ambassadors(id) on delete cascade,
  target_qualified_landlords int not null,
  commission_percent numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commission_tiers_ba_id_requires_override
    check ((scope = 'ba_override' and ba_id is not null) or (scope = 'global' and ba_id is null))
);

create index if not exists idx_commission_tiers_scope on commission_tiers(scope, ba_id, target_qualified_landlords);

-- Now that commission_tiers exists, wire up the fk left pending above.
alter table ba_landlord_claims
  add constraint ba_landlord_claims_commission_tier_id_fkey
  foreign key (commission_tier_id) references commission_tiers(id) on delete set null;

-- ---------------------------------------------------------------------
-- 6. landlords: BA attribution
-- ---------------------------------------------------------------------
alter table landlords add column if not exists ba_id uuid references brand_ambassadors(id) on delete set null;
alter table landlords add column if not exists ba_attribution_disputed boolean not null default false;
alter table landlords add column if not exists ba_attribution_disputed_at timestamptz;

create index if not exists idx_landlords_ba_id on landlords(ba_id);

-- =====================================================================
-- End of Phase 1. Confirm this runs cleanly against the existing
-- Supabase schema before starting Phase 2 (admin onboarding link,
-- self-fill, email confirm & approval).
-- =====================================================================
