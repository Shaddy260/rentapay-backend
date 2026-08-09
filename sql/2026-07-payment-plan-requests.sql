-- =====================================================================
-- FEATURE (direct request: "in-app rent negotiation / payment plan
-- requests - tenant splits a payment, landlord approves/declines
-- in-app"): today a tenant who can't pay in full has to negotiate off
-- platform (call/text/WhatsApp) and the landlord has no record of what
-- was agreed. This gives a tenant a lightweight way to propose
-- splitting their current balance into installments, and gives the
-- landlord/manager a real approve/decline worklist for it - same
-- pattern as charge_disputes: a proposal row plus a plain-language
-- context message dropped into the same landlord_tenant chat thread,
-- so the negotiation and its outcome live in one place either side
-- already checks.
--
-- Deliberately NOT wired into the balance/payment engine itself
-- (approving a plan doesn't auto-split payments.amount_due or change
-- due_day_of_month) - it's a recorded agreement the landlord can point
-- back to, same as a dispute resolution note. Automatically enforcing
-- it is a natural next step once this is validated with real usage.
-- =====================================================================

create table if not exists payment_plan_requests (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null references tenants(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,

  total_amount numeric(12,2) not null,
  -- [{ "amount": 5000, "dueDate": "2026-08-05" }, ...] - tenant-proposed
  -- split; must sum to total_amount (enforced in the controller, not
  -- here, so a decent error message can be given rather than a raw DB
  -- constraint failure).
  installments jsonb not null default '[]'::jsonb,
  reason text,

  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  decision_note text,
  decided_at timestamptz,
  decided_by_role text check (decided_by_role in ('landlord', 'manager')),
  decided_by_id uuid,

  chat_message_id uuid references chat_messages(id) on delete set null,

  created_at timestamptz not null default now()
);

create index if not exists idx_payment_plan_requests_tenant on payment_plan_requests(tenant_id);
create index if not exists idx_payment_plan_requests_landlord_status on payment_plan_requests(landlord_id, status);

-- One open (pending) request per tenant at a time - mirrors the "one
-- open dispute per payment" rule in charge_disputes, for the same
-- reason: a second proposal while one's still awaiting a decision
-- would just fork the conversation.
create unique index if not exists uq_payment_plan_requests_one_pending_per_tenant
  on payment_plan_requests(tenant_id) where status = 'pending';
