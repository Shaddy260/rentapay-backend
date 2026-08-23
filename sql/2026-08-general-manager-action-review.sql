-- ---------------------------------------------------------------------
-- RentaPay — General Manager Accounts (Sectioned Build Spec)
-- Section 6/10 follow-up — Admin Confirmation Queue for GM Actions
-- ---------------------------------------------------------------------
-- Direct request: "the general manager account actions need
-- confirmation by the admin even after they do it with the pin ... i
-- dont see where these pending actions from general managers land ...
-- they should land in admin portal ... and have their own dedicated
-- ui, and admin can confirm or reject one by one or multiple by
-- selecting or all."
--
-- A General Manager's Operations-PIN confirmation (Section 6) is
-- theirs alone - it lets the action go ahead immediately so the GM
-- isn't blocked waiting on admin. But every sensitive action (the
-- same set Section 10 already marks is_revertible: suspend/activate,
-- financial edits, add/delete account, any status change) now ALSO
-- opens a second, admin-side confirmation: it lands in a queue admin
-- must explicitly confirm (acknowledge, no further effect - the
-- action already happened) or reject (undoes it immediately, reusing
-- the exact-state revert already built for Section 10).
--
-- admin_review_status is only ever set on rows that are_revertible
-- (see resolveTable() in generalManagerActivityLog.service.js) -
-- read-only/non-sensitive GM activity never enters this queue at all.
alter table general_manager_activity_logs
  add column if not exists admin_review_status text
    check (admin_review_status in ('pending', 'confirmed', 'rejected')),
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text; -- 'super-admin' — same convention as reverted_by

-- Backfill: any already-outstanding revertible action that hasn't
-- been reverted becomes visible in the queue immediately, instead of
-- only newly-logged actions going forward.
update general_manager_activity_logs
set admin_review_status = 'pending'
where is_revertible = true
  and reverted_at is null
  and admin_review_status is null;

-- Fast "everything currently awaiting review, across every manager"
-- lookup for the admin-portal queue/banner - the whole reason this
-- migration exists.
create index if not exists idx_gm_activity_logs_pending_review
  on general_manager_activity_logs (created_at desc)
  where admin_review_status = 'pending';

-- Done when: every sensitive (is_revertible) GM action starts life as
-- admin_review_status = 'pending', admin can list/confirm/reject them
-- one-by-one or in bulk (see generalManagerReview.controller.js /
-- routes), and rejecting one automatically reverts it via the
-- existing revertGmLog() machinery.
-- ---------------------------------------------------------------------
