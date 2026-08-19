-- 2026-08-utility-invoices-and-first-reading.sql
--
-- Phase 1 of the utility-billing rework:
--   1. utility_invoices - a real, tenant-facing invoice record created
--      the moment a billing run is finalized (Section 7). Previously
--      finalizeRun only bumped tenants.balance_due and sent a text
--      notification - there was no queryable invoice a tenant portal
--      could actually show "just below the payment banner".
--   2. utility_meters.awaiting_previous_reading - lets the frontend
--      detect "this meter has never had a reading" and prompt the
--      landlord/manager/caretaker for the previous reading before the
--      current one, instead of silently recording the first entry as
--      a baseline with no bill.
--
-- NOTE: this migration intentionally leaves tenants.balance_due as a
-- single combined figure for now - splitting rent vs. utility
-- balances is Phase 2. finalizeRun keeps bumping balance_due so
-- nothing existing breaks; utility_invoices is additive and is what
-- the tenant-facing "bills" UI will read from once Phase 2 lands.

create table if not exists utility_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,

  meter_id uuid not null references utility_meters(id) on delete cascade,
  run_id uuid not null references utility_billing_runs(id) on delete cascade,
  run_unit_id uuid not null references utility_billing_run_units(id) on delete cascade,

  utility_type text not null, -- 'water' | 'electricity' | whatever the meter is set up as
  month_key text not null,
  usage_amount numeric(12,2),
  rate_per_unit numeric(12,2),
  amount numeric(12,2) not null,

  status text not null default 'unpaid' check (status in ('unpaid', 'paid', 'partially_paid', 'void')),
  amount_paid numeric(12,2) not null default 0,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  -- one invoice per unit per run - finalize is the only writer and
  -- only ever runs once per run per unit
  unique (run_unit_id)
);

create index if not exists idx_utility_invoices_tenant on utility_invoices(tenant_id);
create index if not exists idx_utility_invoices_unit on utility_invoices(unit_id);
create index if not exists idx_utility_invoices_landlord on utility_invoices(landlord_id);
create index if not exists idx_utility_invoices_status on utility_invoices(status);

-- Lets the frontend show "no meter reading yet - what was the reading
-- before this one?" instead of the old silent-baseline behavior.
alter table utility_meters add column if not exists awaiting_previous_reading boolean default true;
comment on column utility_meters.awaiting_previous_reading is
  'True until this meter has any reading on file. The submit-reading endpoint responds with needsPreviousReading=true while this is set, so the UI can ask for the previous reading before the current one.';

update utility_meters m
set awaiting_previous_reading = not exists (
  select 1 from utility_readings r where r.meter_id = m.id
);
