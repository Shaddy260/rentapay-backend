-- =====================================================================
-- BUILD SPEC PHASE 10 - Payout Rules Engine, Qualification & Commission
-- Tiers.
--
-- payout_rules / commission_tiers / ba_landlord_claims (payout_amount,
-- commission_bonus_amount, commission_tier_id, qualified_at) and
-- brand_ambassadors.current_commission_percent already exist from
-- Phase 1 (see add-brand-ambassador-role.sql) - nothing to add there.
--
-- What THIS migration adds:
--   1. notifications.recipient_type widened to include
--      'brand_ambassador' - the qualification job (and Phase 6's
--      settings page) needs the in-app inbox row, not just the push
--      subscription (push_subscriptions was already widened in
--      add-brand-ambassador-profile-photo-and-push.sql).
--   2. A seeded global payout_rules row and a starter commission_tiers
--      ladder, ONLY if none exists yet - so the qualification job has
--      something sane to run against out of the box rather than
--      silently qualifying nobody (amount = 0) or erroring on an empty
--      table. Admin can change every one of these values via the new
--      endpoints in payoutRules.controller.js immediately after.
-- =====================================================================

alter table notifications drop constraint if exists notifications_recipient_type_check;
alter table notifications add constraint notifications_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant', 'scout', 'admin', 'brand_ambassador'));

-- Seed ONE global payout rule if the table is empty. KES 1,500 per
-- qualified landlord, after 2 consecutive paid months, min 1 unit -
-- deliberately conservative defaults; admin should review/adjust via
-- PATCH /api/brand-ambassadors/payout-rules/global right away.
insert into payout_rules (scope, ba_id, amount, required_consecutive_months, min_units)
select 'global', null, 1500, 2, 1
where not exists (select 1 from payout_rules where scope = 'global');

-- Seed a starter global commission ladder if none exists yet:
--   5 qualified landlords  -> 5%
--   15 qualified landlords -> 8%
--   30 qualified landlords -> 12%
insert into commission_tiers (scope, ba_id, target_qualified_landlords, commission_percent)
select v.target, v.pct
from (values (5, 5), (15, 8), (30, 12)) as v(target, pct)
where not exists (
  select 1 from commission_tiers where scope = 'global' and target_qualified_landlords = v.target
);

-- =====================================================================
-- End of Phase 10 migration.
-- =====================================================================
