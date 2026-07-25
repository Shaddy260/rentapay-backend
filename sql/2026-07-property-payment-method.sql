-- =====================================================================
-- 2026-07-property-payment-method.sql
--
-- BUG: a landlord with more than one apartment/property who updated
-- "the payment method" was actually updating landlords.payment_method
-- - a single column on the landlord's own row - which every property
-- they own reads from. So editing the payment method while viewing
-- Apartment A silently changed what Apartment B's tenants were told
-- to pay to as well.
--
-- FIX: give `properties` the exact same override pattern units already
-- have (see 2026-07-updates-v3.sql, section 1). When
-- payment_override_enabled is true on a property, buildPaymentInstructions()
-- prefers these fields for every unit in that property - UNLESS that
-- specific unit has its own unit-level override switched on, which
-- still wins (most specific override wins: unit > property > landlord
-- default).
--
-- Safe to run multiple times (every statement is guarded).
-- =====================================================================

alter table properties add column if not exists payment_override_enabled boolean not null default false;
alter table properties add column if not exists payment_override_method text
  check (payment_override_method in ('stk', 'paybill', 'till'));
alter table properties add column if not exists payment_override_paybill_number text;
alter table properties add column if not exists payment_override_paybill_account_number text;
alter table properties add column if not exists payment_override_till_number text;
