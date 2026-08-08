-- =====================================================================
-- Migration: 2026-07 updates v2 (run this once in Supabase SQL Editor)
-- =====================================================================
-- Adds support for:
--   1. Paid "add a new property" flow from the landlord dashboard's
--      property switcher - a landlord can register another property
--      (name + unit count), pay for those units via M-Pesa STK push,
--      and only then does the property/units become usable - mirrors
--      the same pattern as subscription_payments.
-- =====================================================================

create table if not exists property_payments (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,

  -- Property details captured up-front, applied once payment completes
  name text not null,
  location text,
  county text,
  description text,
  manager_name text,
  manager_phone text,
  units_count integer not null,

  amount numeric not null,
  mpesa_checkout_request_id text,
  mpesa_transaction_id text,
  mpesa_phone text,
  status text not null default 'pending', -- pending | completed | failed

  created_property_id uuid references properties(id) on delete set null,

  paid_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_property_payments_landlord on property_payments(landlord_id);
create index if not exists idx_property_payments_checkout on property_payments(mpesa_checkout_request_id);
