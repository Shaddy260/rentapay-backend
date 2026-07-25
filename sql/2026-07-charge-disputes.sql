-- =====================================================================
-- FEATURE (direct request: "dispute a charge - a lightweight 'this
-- doesn't look right' button on any line item that opens a chat
-- thread pre-filled with context"): today, if a tenant thinks a
-- payment row is wrong, their only path is to type up the whole
-- situation from scratch in the landlord_tenant chat (or worse, over
-- WhatsApp, invisible to RentaPay entirely) - the landlord has no
-- signal on the payment row itself that anything is contested.
--
-- This table is the persisted half of that feature: one row per
-- dispute, linked to the chat message it kicked off (see
-- dispute.controller.js, which posts a pre-filled context bubble into
-- the existing landlord_tenant thread AND writes this row so the
-- payment row can show a "Disputed" badge and the landlord has a
-- worklist instead of having to remember which chat threads had a
-- complaint buried in them).
--
-- Deliberately keyed as (payment_id, landlord_id, tenant_id) rather
-- than just payment_id alone, mirroring chat_messages' own shape, so
-- every other query in this feature (landlord's "my disputes" list,
-- tenant's own dispute status) can filter without a join back through
-- payments every time.
--
-- Scoped to payments for now ("any line item" in the request maps to
-- the payment history rows already on screen in both portals) - if
-- disputes are ever needed on another line-item type (an expense line,
-- a scout payout), add a nullable FK column for that type rather than
-- overloading payment_id, so existing rows/queries here are untouched.
-- =====================================================================

create table if not exists charge_disputes (
  id uuid primary key default gen_random_uuid(),

  payment_id uuid not null references payments(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,

  -- Whoever tapped "This doesn't look right" - in practice almost
  -- always the tenant, but a landlord/manager can also flag their own
  -- recorded entry as needing a second look (e.g. a manual payment
  -- they suspect was mis-keyed), so this isn't tenant-only.
  raised_by_role text not null check (raised_by_role in ('tenant', 'landlord', 'manager')),
  raised_by_id uuid not null,

  reason text, -- optional free-text the raiser typed before submitting

  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  resolved_by_role text check (resolved_by_role in ('landlord', 'manager', 'admin')),
  resolved_by_id uuid,
  resolution_note text,

  -- The chat bubble this dispute opened with, pre-filled with the
  -- payment's context (date/amount/method/status) plus the reason -
  -- lets the UI offer a "View conversation" link straight from the
  -- payment row without re-deriving which thread/message it was.
  chat_message_id uuid references chat_messages(id) on delete set null,

  created_at timestamptz not null default now()
);

-- One OPEN dispute per payment at a time - once resolved, a new one
-- can be raised (e.g. the same charge goes wrong again next month),
-- but you shouldn't be able to double-submit two open disputes on the
-- same line item and confuse the landlord's worklist.
create unique index if not exists uq_charge_disputes_open_payment
  on charge_disputes(payment_id)
  where status = 'open';

create index if not exists idx_charge_disputes_payment on charge_disputes(payment_id);
create index if not exists idx_charge_disputes_landlord_status on charge_disputes(landlord_id, status);
create index if not exists idx_charge_disputes_tenant on charge_disputes(tenant_id);
