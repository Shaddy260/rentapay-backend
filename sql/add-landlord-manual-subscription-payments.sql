-- =====================================================================
-- Direct request: landlord subscription payments need a manual
-- fallback ("sometimes the popup is not sent, so there should be a
-- ui underneath that says didn't receive the popup...pay manually")
-- that lands in a NEW admin-only queue ("landlords manual payment
-- confirmations") with Confirm / Reject / Delete, separate from the
-- existing tenant-facing pending_payment_confirmations table (that
-- one is scoped to tenant_id/unit_id, which a landlord paying their
-- OWN platform subscription doesn't have).
--
-- Whoever submits this can be the landlord, a manager, or a
-- caretaker on that account (direct request: "whatever happens in
-- landlord subscription, the managers and caretakers account should
-- be the same too since they see same as landlords") - submitted_by_*
-- records exactly who, landlord_id is always the account this
-- payment is meant to renew/activate.
-- =====================================================================

create table if not exists landlord_manual_subscription_payments (
  id uuid primary key default gen_random_uuid(),

  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid references properties(id) on delete set null, -- set when this is renewing/activating one specific apartment's own clock, null when it's the account-wide (original property) subscription

  submitted_by_role text not null check (submitted_by_role in ('landlord', 'manager', 'caretaker')),
  submitted_by_landlord_id uuid references landlords(id) on delete set null,
  submitted_by_manager_id uuid references property_managers(id) on delete set null,

  transaction_code text not null,
  amount_paid numeric(12,2) not null,
  mpesa_payer_name text not null,
  mpesa_payer_phone text not null,
  mpesa_sms_timestamp timestamptz,

  period_months int not null default 1,
  units_count int not null,

  submitted_at timestamptz not null default now(),

  status text check (status in ('pending', 'confirmed', 'rejected')) not null default 'pending',

  actioned_by_admin_id uuid,
  confirmed_or_rejected_at timestamptz,
  rejection_reason text,

  created_at timestamptz not null default now()
);

create index if not exists idx_landlord_manual_sub_payments_status on landlord_manual_subscription_payments(status, submitted_at desc);
create index if not exists idx_landlord_manual_sub_payments_landlord on landlord_manual_subscription_payments(landlord_id);
