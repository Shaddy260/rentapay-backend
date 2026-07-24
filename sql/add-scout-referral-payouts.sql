-- =====================================================================
-- FEATURE (direct request: scout referral payout tracking). Right now
-- a scout gets attribution credit (status flips to 'placed') and the
-- landlord gets notified, but there is no in-app record of whether the
-- scout was ever actually paid for that placement - the whole
-- financial side happens off-platform with nothing to show for it.
-- This adds a payout column set an admin can update once a scout has
-- actually been paid (however that payment happened - M-Pesa,
-- cash, etc. - this just records that it did, not how).
-- =====================================================================

alter table scout_referrals add column if not exists payout_status text not null default 'not_applicable'
  check (payout_status in ('not_applicable', 'pending', 'paid'));
alter table scout_referrals add column if not exists payout_amount numeric(10,2);
alter table scout_referrals add column if not exists payout_note text;
alter table scout_referrals add column if not exists payout_paid_at timestamptz;

-- The moment a referral flips to 'placed' (see
-- scoutReferral.service.js's creditPlacementIfEligible), its
-- payout_status should move from 'not_applicable' to 'pending' so it
-- shows up in the admin's "owed to scouts" queue - handled in the
-- application code alongside that same status flip, not here, since
-- it depends on the placement-credit business logic already there.

create index if not exists idx_scout_referrals_payout_status on scout_referrals(payout_status, placed_at desc);
