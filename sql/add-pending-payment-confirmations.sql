-- =====================================================================
-- ADD: pending_payment_confirmations
-- Manual Paybill payment confirmation flow - tenants pay rent by
-- sending money directly to their landlord's own Till/Paybill/Phone
-- (NOT via Daraja/STK push), then submit proof here for the landlord
-- or property manager to manually confirm or reject. Run this once,
-- manually, in the Supabase SQL editor - same convention as every
-- other file in sql/ (never edit schema.sql directly).
-- =====================================================================

create table if not exists pending_payment_confirmations (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null references tenants(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid references properties(id) on delete set null, -- optional, multi-property support

  transaction_code text not null,      -- normalized uppercase/trimmed M-Pesa code
  amount_paid numeric(12,2) not null,
  mpesa_payer_name text not null,
  mpesa_sms_timestamp timestamptz,     -- optional - the time shown on the tenant's M-Pesa SMS, NOT auto-generated

  submitted_at timestamptz not null default now(), -- auto-captured, not editable by tenant

  status text check (status in ('pending', 'confirmed', 'rejected')) not null default 'pending',

  -- Which user account actioned it - split into two FK columns since a
  -- landlord and a property manager live in two different tables and
  -- Postgres FKs can only reference one. Exactly one of these is set
  -- per row (whichever role actually confirmed/rejected); the other
  -- stays null. "on delete set null" so a deleted landlord/manager
  -- account doesn't take the historical record down with it - the
  -- receipt/confirmation record should still say who did it even
  -- after that account is gone (we also snapshot their name into
  -- payments.recorded_note at confirm time for the same reason).
  confirmed_or_rejected_by_landlord uuid references landlords(id) on delete set null,
  confirmed_or_rejected_by_manager uuid references property_managers(id) on delete set null,
  confirmed_or_rejected_at timestamptz,
  rejection_reason text,

  -- Fraud flag: set when transaction_code matched an existing
  -- CONFIRMED record at submission time. The record is still created
  -- (not silently rejected) - a human decides.
  duplicate_of uuid references pending_payment_confirmations(id) on delete set null,

  created_at timestamptz not null default now(),

  constraint chk_single_confirmer check (
    confirmed_or_rejected_by_landlord is null or confirmed_or_rejected_by_manager is null
  )
);

-- Fast duplicate lookups on submit
create index if not exists idx_pending_payment_confirmations_txn_code
  on pending_payment_confirmations(transaction_code);

-- Fast pending-list query, scoped per landlord
create index if not exists idx_pending_payment_confirmations_landlord_status
  on pending_payment_confirmations(landlord_id, status);
