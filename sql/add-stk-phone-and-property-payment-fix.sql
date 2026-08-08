-- =====================================================================
-- Two direct requests:
--
-- 1. "The payment method between the landlord's apartments is
-- merging - it should be independent per apartment." The DB columns
-- for a per-property override (payment_override_enabled/method/
-- paybill_number/etc) already existed on `properties` (see
-- 2026-07-property-payment-method.sql) - but NO endpoint ever existed
-- to actually write to them. The Settings "Edit payment method" UI
-- was calling the landlord-wide endpoint regardless of which
-- apartment was selected, which is the actual reason every apartment
-- showed the same payment details - there was no per-property write
-- path at all, override columns or not. Fixed in
-- property.controller.js (new updatePropertyPaymentOverride
-- function) - this migration only adds the STK phone number columns
-- below, everything else needed already existed.
--
-- 2. "When a landlord sets payment method as STK push, they should
-- also add the number - shown below the words STK push."
-- =====================================================================

alter table landlords add column if not exists stk_phone_number text;
alter table properties add column if not exists payment_override_stk_phone_number text;
