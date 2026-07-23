-- =====================================================================
-- Direct request: "when a landlord is entering the tenant details to
-- a unit they should record whether a tenant had paid deposit at
-- first entering of the house...that deposit should be read only to
-- the tenants and should not count as rent...should actually be a
-- security deposit refundable upon vacating depending on damages."
--
-- Deliberately separate from balance_due/payments - a deposit is not
-- rent and must never be added to or drawn from the rent ledger. It's
-- its own record: what was collected at move-in, and (later, at
-- move-out) what was returned vs withheld and why. RentaPay is not an
-- escrow service (see Terms) - this is pure record-keeping, the same
-- role it already plays for rent.
-- =====================================================================

alter table tenants add column if not exists deposit_amount numeric(12,2);
alter table tenants add column if not exists deposit_paid_at date;

-- 'held'      - collected at move-in, nothing settled yet (default
--               once a deposit_amount is recorded)
-- 'refunded'  - full amount returned at move-out
-- 'partially_refunded' - some withheld for damages/arrears, rest returned
-- 'forfeited' - none returned
alter table tenants add column if not exists deposit_status text
  check (deposit_status in ('held', 'refunded', 'partially_refunded', 'forfeited'));

alter table tenants add column if not exists deposit_refunded_amount numeric(12,2);
alter table tenants add column if not exists deposit_deduction_reason text;
alter table tenants add column if not exists deposit_settled_at timestamptz;
alter table tenants add column if not exists deposit_settled_by_type text; -- 'landlord' | 'manager'
alter table tenants add column if not exists deposit_settled_by_id uuid;
