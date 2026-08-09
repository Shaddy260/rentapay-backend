-- =====================================================================
-- Direct request: "a landlord or scout can decide to submit again a
-- code that has been used already...in the admin side it does not
-- flag this like how the tenants side is flagged and marked...the
-- same principle should apply."
--
-- pending_payment_confirmations (tenant-side) already has a
-- `duplicate_of` column (add-payment-confirmation-resubmission.sql)
-- pointing at the earlier CONFIRMED record with the same transaction
-- code, so the admin/landlord UI can flag "this M-Pesa code was
-- already used" instead of silently letting it through again.
-- landlord_manual_subscription_payments and scout_manual_county_
-- payments never got the same column, so the exact same reused-code
-- scenario on those two flows had nothing to flag it with at all.
-- =====================================================================

alter table landlord_manual_subscription_payments
  add column if not exists duplicate_of uuid references landlord_manual_subscription_payments(id) on delete set null;

alter table scout_manual_county_payments
  add column if not exists duplicate_of uuid references scout_manual_county_payments(id) on delete set null;

create index if not exists idx_landlord_manual_sub_payments_duplicate_of on landlord_manual_subscription_payments(duplicate_of);
create index if not exists idx_scout_manual_county_payments_duplicate_of on scout_manual_county_payments(duplicate_of);
