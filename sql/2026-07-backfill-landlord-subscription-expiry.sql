-- =====================================================================
-- Backfill: subscription_expires_at was never set on a landlord's
-- FIRST activation (only on renewals - see activateLandlordAfterPayment
-- in auth.controller.js, now fixed to set it going forward). Any
-- landlord who activated before that fix is stuck with a null expiry
-- until it's patched manually - this is exactly the "subscription
-- counter is normally null until I go adjust it in Supabase myself"
-- report. Run this ONCE against existing data; new activations no
-- longer need it.
--
-- Only touches landlords that are genuinely active/verified with a
-- missing expiry - never a still-pending signup (those correctly have
-- no expiry yet; they haven't paid) and never a landlord whose expiry
-- is already set (a real renewal, or already manually patched).
-- =====================================================================

update landlords
set subscription_expires_at = coalesce(subscription_started_at, updated_at, now())
                               + (coalesce(subscription_period_months, 1) || ' months')::interval
where subscription_expires_at is null
  and is_verified = true
  and subscription_status in ('active', 'warning', 'expired', 'suspended');

-- Sanity check: run this after the update above - should return 0 rows.
-- select id, full_name, phone, subscription_status, subscription_started_at, subscription_expires_at
-- from landlords
-- where subscription_expires_at is null and is_verified = true and subscription_status in ('active', 'warning', 'expired', 'suspended');
