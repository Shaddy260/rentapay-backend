-- =====================================================================
-- SCOUT REFERRAL TRACKING & NOTIFICATIONS
--
-- 1) units.last_verified_at - separate from updated_at. Stamped only
--    when a landlord/manager/caretaker explicitly taps "Still vacant -
--    confirm" (PATCH /units/:id/verify). Kept distinct from
--    updated_at deliberately: a rent-amount typo fix or any other edit
--    also bumps updated_at, which would falsely read as "freshly
--    confirmed vacant" to a scout browsing the vacancy list.
-- =====================================================================
alter table units add column if not exists last_verified_at timestamptz;

-- =====================================================================
-- 2) scout_referrals - single source of truth for the referral
--    pipeline: a scout shares a vacant unit with a prospective tenant
--    (status 'shared'), a landlord/manager/caretaker opens the referral
--    (status 'viewed_by_landlord'), and if the unit gets rented within
--    the credit window, the referral is auto-credited as a 'placed'
--    placement. 'expired' is reserved for a future cleanup job/view
--    that marks referrals past the placement-credit window as no
--    longer active, so old shares stop showing as "active" badges/
--    Attention Feed items - nothing currently writes 'expired'
--    directly; it's computed by filtering on shared_at age wherever
--    "active referral" is checked (see scoutReferral.service.js).
-- =====================================================================
create table if not exists scout_referrals (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid not null references scouts(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,
  status text not null default 'shared' check (status in ('shared', 'viewed_by_landlord', 'placed', 'expired')),
  shared_at timestamptz not null default now(),
  viewed_at timestamptz,
  placed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Fast "does this scout already have a recent referral for this unit"
-- check (used for the 24h SMS re-notify cooldown) and fast "active
-- referrals for this unit/landlord" lookups (badge, Attention Feed,
-- placement credit).
create index if not exists idx_scout_referrals_scout_unit on scout_referrals(scout_id, unit_id, shared_at desc);
create index if not exists idx_scout_referrals_unit on scout_referrals(unit_id, status);
create index if not exists idx_scout_referrals_landlord on scout_referrals(landlord_id, status, shared_at desc);
