-- =====================================================================
-- FEATURE (direct request): tenant self-onboarding link now also asks
-- for the deposit amount the tenant has already paid, if any - "if
-- none then they leave it empty". Run this in the Supabase SQL
-- Editor AFTER 2026-07-tenant-self-onboarding.sql.
--
-- Deliberately its own nullable column, separate from anything on
-- `units` - this is the TENANT's self-reported figure, reviewed and
-- correctable by the landlord/manager/caretaker before it's ever
-- trusted (see confirmOnboardingRequest, which is where it's finally
-- written into tenants.deposit_amount).
-- =====================================================================
alter table tenant_onboarding_requests
  add column if not exists deposit_amount_paid numeric;
