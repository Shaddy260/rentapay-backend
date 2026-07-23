-- =====================================================================
-- FIX ("subscription expired shouldn't say 'account suspended'"):
-- the subscription-expiry cron job (subscriptionReminders.job.js) was
-- writing subscription_status = 'suspended' for a lapsed subscription
-- - the exact same value the admin panel writes when an admin
-- deliberately bans a landlord (admin.controller.js setLandlordStatus).
-- login() then treated both identically: a flat 403 "Your account has
-- been suspended. Contact RentaPay support," with no way in at all.
--
-- That's correct for an admin ban, but wrong for an expired
-- subscription - a landlord should still be able to log in and see
-- their own dashboard/data, just with a persistent "renew now" banner
-- and payment features blocked, not be locked out entirely.
--
-- This adds a distinct 'expired' status so the two cases can finally
-- be told apart. Existing 'suspended' rows are left as-is (they were
-- always meant to be an admin ban); only the job that auto-flips
-- accounts on expiry now writes 'expired' instead.
-- =====================================================================

alter table landlords drop constraint if exists landlords_subscription_status_check;
alter table landlords add constraint landlords_subscription_status_check
  check (subscription_status in ('pending', 'active', 'warning', 'expired', 'suspended'));
