-- =====================================================================
-- Consolidated Change Instructions - Sections A, B, C
--
-- A. Remove manual BA claim logging entirely (ba_landlord_claims table
--    and every function/route built on it).
-- B. "My Onboarded Landlords" becomes the single live list, sourced
--    directly from landlords.ba_id.
-- C. Qualification is evaluated directly against landlords - a
--    one-time gate per landlord (ba_id is not null AND a completed
--    payment exists AND at least one unit is set up).
--
-- This migration is additive-then-destructive: it adds the new
-- qualification columns to `landlords` FIRST (and backfills them from
-- the outgoing ba_landlord_claims table, so no existing qualified
-- landlord silently reverts to "pending"), THEN drops
-- ba_landlord_claims.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. New qualification columns on landlords (Section C)
-- ---------------------------------------------------------------------
alter table landlords add column if not exists ba_qualification_status text not null default 'pending'
  check (ba_qualification_status in ('pending', 'qualified'));
alter table landlords add column if not exists ba_qualified_at timestamptz;

create index if not exists idx_landlords_ba_qualification
  on landlords(ba_id, ba_qualification_status);

-- ---------------------------------------------------------------------
-- 2. Backfill from the outgoing ba_landlord_claims table, if present,
--    so a landlord already qualified/paid under the old model doesn't
--    silently revert to 'pending' the moment the claims table is
--    dropped. Qualification remains a one-time gate (Section C) - this
--    is exactly that: carry the gate forward, once, at cutover.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'ba_landlord_claims') then
    update landlords l
    set ba_qualification_status = 'qualified',
        ba_qualified_at = coalesce(c.qualified_at, now())
    from (
      select distinct on (matched_landlord_id) matched_landlord_id, qualified_at
      from ba_landlord_claims
      where matched_landlord_id is not null
        and qualification_status in ('qualified', 'paid')
      order by matched_landlord_id, qualified_at asc
    ) c
    where l.id = c.matched_landlord_id;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Drop the manual-claim-logging table entirely (Section A) - no
--    fallback path exists anymore. A landlord is attached to a BA
--    only via the referral link/code at signup (landlords.ba_id).
-- ---------------------------------------------------------------------
drop table if exists ba_landlord_claims cascade;

-- =====================================================================
-- End of migration. After this runs:
--   - ba_landlord_claims no longer exists.
--   - landlords.ba_qualification_status / ba_qualified_at drive both
--     the live "My Onboarded Landlords" list (Section B) and the daily
--     qualification job (Section C).
--   - Sections D-G (referral code format, percentage commission,
--     Payout Run, PDF export) are NOT part of this migration and are
--     not yet implemented - the admin Payout Run / PDF export /
--     earnings-statement screens still reference the now-dropped
--     table and will need to be rebuilt against payout_rules /
--     landlords once those sections are implemented.
-- =====================================================================
