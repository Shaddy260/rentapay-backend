-- 2026-08-p1-p2-manual-amount-validation-and-discount-expiry.sql
--
-- P1 (loyalty-discount-roadmap.md) - "Validate manual payment amounts
-- against the discounted price". Adds a column to record what the
-- system expected the landlord to pay (via calculateSubscriptionCost,
-- discount included) at the moment a manual payment was submitted, so
-- it can be compared against what they actually said they paid
-- (amount_paid) - both at submission time (frontend shows it inline)
-- and at admin-review time (flagged, not blocked, same visual
-- treatment as the existing duplicate-transaction-code flag).
--
-- P2 - "Give a granted discount an expiry". Adds expires_at to
-- landlord_loyalty_discounts so a grant no longer sits active
-- indefinitely - see landlordLoyalty.service.js /
-- loyaltyDiscountExpiry.job.js for how it's read/enforced.

-- ---------------------------------------------------------------------
-- P1: landlord_manual_subscription_payments - expected amount at
-- submission time.
-- ---------------------------------------------------------------------
alter table landlord_manual_subscription_payments
  add column if not exists expected_amount numeric;

comment on column landlord_manual_subscription_payments.expected_amount is
  'What calculateSubscriptionCost() said this landlord should owe (loyalty discount included) at the moment this manual payment was submitted. Null for rows submitted before this migration, or where the underlying property_payments row (property renewals/purchases) is the authoritative amount instead. Compared against amount_paid to flag (never block) a mismatch for the admin reviewing it.';

-- ---------------------------------------------------------------------
-- P2: landlord_loyalty_discounts - expiry.
-- ---------------------------------------------------------------------
alter table landlord_loyalty_discounts
  add column if not exists expires_at timestamptz;

comment on column landlord_loyalty_discounts.expires_at is
  'When this grant stops applying if unused. Default is 30 days from grant (admin can override per batch when granting). Null means "never expires" - only true for rows granted before this migration; every new grant gets a value. A row past its expires_at is treated as inactive everywhere it is read (see getActiveDiscountForLandlord etc.), and is swept to is_active = false by loyaltyDiscountExpiry.job.js.';

create index if not exists idx_loyalty_discount_expires_at on landlord_loyalty_discounts(expires_at) where is_active = true;
