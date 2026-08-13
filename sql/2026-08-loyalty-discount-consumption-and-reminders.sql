-- 2026-08-loyalty-discount-consumption-and-reminders.sql
--
-- DIRECT REQUEST: "after a landlord renews subscription with the
-- discount... it should expire unless given another one" - a granted
-- loyalty discount used to stay active forever (see
-- landlord_loyalty_discounts.is_active in
-- 2026-08-subscription-pricing-and-loyalty-discounts.sql), so the same
-- discount kept applying to every renewal indefinitely. This migration
-- adds the columns needed to make a discount ONE-TIME: consumed
-- (deactivated) the moment the renewal payment it was attached to
-- actually completes - never on a failed/abandoned STK push, so a
-- landlord doesn't lose their discount to a payment that never went
-- through.
--
-- Also adds the columns needed for the "remind landlords whose
-- subscription hasn't ended that they have a discount waiting on their
-- next renewal" in-app popup (snooze state lives on the discount row
-- itself, same one-reminder-thread-per-grant model as
-- tenant-rating-reminders.sql).

-- ---------------------------------------------------------------------
-- 1. landlord_loyalty_discounts - consumption + reminder-snooze state
-- ---------------------------------------------------------------------
alter table landlord_loyalty_discounts
  add column if not exists consumed_at timestamptz,
  add column if not exists consumed_by_subscription_payment_id uuid,
  add column if not exists consumed_by_manual_payment_id uuid,
  add column if not exists consumed_by_property_payment_id uuid,
  add column if not exists reminder_snoozed_until timestamptz,
  add column if not exists reminder_dismissed_today_at date;

create index if not exists idx_loyalty_discount_consumed on landlord_loyalty_discounts(consumed_at);

-- ---------------------------------------------------------------------
-- 2. subscription_payments - which discount (if any) was attached at
--    the moment this renewal was initiated (Daraja/STK path). Set on
--    insert (renewSubscription), only acted on (discount marked
--    consumed) once the Daraja callback confirms the payment actually
--    completed - a pending/failed STK push never touches the discount.
-- ---------------------------------------------------------------------
alter table subscription_payments
  add column if not exists loyalty_discount_id uuid references landlord_loyalty_discounts(id);

create index if not exists idx_sub_payments_loyalty_discount on subscription_payments(loyalty_discount_id);

-- ---------------------------------------------------------------------
-- 3. landlord_manual_subscription_payments - same idea for the
--    manual-payment-confirmed-by-admin path. Set on submission, only
--    acted on once an admin confirms the record.
-- ---------------------------------------------------------------------
alter table landlord_manual_subscription_payments
  add column if not exists loyalty_discount_id uuid references landlord_loyalty_discounts(id);

create index if not exists idx_manual_sub_payments_loyalty_discount on landlord_manual_subscription_payments(loyalty_discount_id);

-- ---------------------------------------------------------------------
-- 4. property_payments - closes a gap found after the first pass of
--    this migration shipped: property.controller.js's
--    initiatePropertyPurchase (buying an additional property) and
--    renewPropertySubscription (renewing one property's own clock)
--    BOTH already pass landlordId into calculateSubscriptionCost, so a
--    landlord's loyalty discount was already being applied to the
--    price on this path - it just had nowhere to record which
--    discount was used, so it was never consumed. That meant a
--    landlord who renewed via "manage this property" instead of the
--    landlord-wide "manage subscription" screen kept their discount
--    forever, reusable on every future property purchase/renewal.
--    Same fix as sections 2/3 above: capture at initiation, consume
--    only once completePropertyPurchase (the shared, idempotent
--    completion point for both the Daraja callback and the manual-
--    payment-confirmed-by-admin path) confirms the payment actually
--    went through.
-- ---------------------------------------------------------------------
alter table property_payments
  add column if not exists loyalty_discount_id uuid references landlord_loyalty_discounts(id);

create index if not exists idx_property_payments_loyalty_discount on property_payments(loyalty_discount_id);
