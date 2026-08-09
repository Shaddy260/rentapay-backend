-- =====================================================================
-- Scout lead pipeline visibility: "does anyone know a good plumber"
-- was community, this is the OTHER direct request - scout_referrals
-- currently only tracks a scout sharing a VACANT UNIT LISTING with a
-- landlord (shared -> viewed_by_landlord -> placed/expired, all
-- either automatic or landlord-triggered). There is no way for a
-- scout to show progress on an actual PROSPECTIVE TENANT they're
-- working - a scout who found someone, got them talking to the
-- landlord, and lined up a viewing has no way to show that effort
-- until the unit either gets rented (auto-credited, sometimes weeks
-- later) or doesn't. This adds:
--
--   1. Optional prospect_name/prospect_phone, captured when a scout
--      refers a unit, so a referral can represent an actual person,
--      not just an anonymous "someone might rent this."
--   2. Two new SELF-REPORTED stages a scout can advance through:
--      'contacted' and 'viewing_scheduled', sitting between 'shared'
--      and 'placed'. Deliberately scout-settable (not landlord- or
--      admin-gated) since chasing a landlord for confirmation on
--      every step of a lead's progress would defeat the "gives scouts
--      a reason to check back in" point of this - but 'placed' stays
--      exactly as it was: automatic-only, credited when the unit
--      actually goes occupied, never self-declared, so nobody can
--      claim a payout for a placement that didn't happen.
--
-- 'viewed_by_landlord' is kept as-is (a signal about the LANDLORD's
-- behavior, not the scout's) - it now sits alongside the scout's own
-- progress rather than gating it; see scout.controller.js
-- markReferralViewed for the updated (no-longer-'shared'-only) guard.
-- =====================================================================

alter table scout_referrals add column if not exists prospect_name text;
alter table scout_referrals add column if not exists prospect_phone text;
alter table scout_referrals add column if not exists stage_updated_at timestamptz;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'scout_referrals_status_check') then
    alter table scout_referrals drop constraint scout_referrals_status_check;
  end if;
end $$;

alter table scout_referrals
  add constraint scout_referrals_status_check
  check (status in ('shared', 'contacted', 'viewing_scheduled', 'viewed_by_landlord', 'placed', 'expired'));

-- VERIFICATION:
--   select column_name from information_schema.columns where table_name = 'scout_referrals' and column_name in ('prospect_name','prospect_phone','stage_updated_at');
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'scout_referrals_status_check';
-- =====================================================================
