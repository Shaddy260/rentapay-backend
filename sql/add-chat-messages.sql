-- =====================================================================
-- CHAT / DIRECT MESSAGING SYSTEM
-- Adds a real two-way chat between:
--   1) admin  <-> landlord   (replaces "reach us directly" with a live chat)
--   2) admin  <-> tenant     (same, from the tenant portal side)
--   3) landlord <-> tenant   ("text your landlord" inside the tenant portal,
--                             and the matching thread inside the landlord
--                             dashboard for that specific tenant)
--
-- Each row is one chat bubble. A conversation is identified by
-- (thread_type, landlord_id, tenant_id) - tenant_id is null for the
-- admin<->landlord thread, and both landlord_id/tenant_id are set for
-- the landlord<->tenant thread (tenant_id already implies landlord_id,
-- but we store both so admin can query "all threads for landlord X"
-- and "all threads for tenant Y" without a join).
--
-- reply_to_id gives the WhatsApp-style "reply to a specific bubble"
-- behaviour: the client greys out/quotes the referenced message above
-- the reply.
-- =====================================================================

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),

  thread_type text not null check (thread_type in ('admin_landlord', 'admin_tenant', 'landlord_tenant')),
  landlord_id uuid references landlords(id) on delete cascade, -- set for all thread types
  tenant_id uuid references tenants(id) on delete cascade,     -- set for admin_tenant and landlord_tenant

  sender_role text not null check (sender_role in ('admin', 'landlord', 'tenant')),
  sender_id uuid, -- landlords.id / tenants.id; null when sender_role = 'admin'
  sender_name text not null, -- snapshot at send-time so history reads fine even if the account is later renamed/removed

  body text not null,
  reply_to_id uuid references chat_messages(id) on delete set null,

  -- Read tracking is per-side (each thread only ever has two sides),
  -- rather than per-individual-admin-user, since any admin user
  -- reading a thread should mark it read for the whole admin team.
  read_by_admin boolean not null default false,
  read_by_landlord boolean not null default false,
  read_by_tenant boolean not null default false,

  created_at timestamptz not null default now()
);

-- A thread must reference the right owning IDs for its type.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_messages_thread_shape'
  ) then
    alter table chat_messages
      add constraint chat_messages_thread_shape check (
        (thread_type = 'admin_landlord' and landlord_id is not null and tenant_id is null) or
        (thread_type = 'admin_tenant'   and tenant_id is not null) or
        (thread_type = 'landlord_tenant' and landlord_id is not null and tenant_id is not null)
      );
  end if;
end $$;

create index if not exists idx_chat_admin_landlord on chat_messages(thread_type, landlord_id) where thread_type = 'admin_landlord';
create index if not exists idx_chat_admin_tenant on chat_messages(thread_type, tenant_id) where thread_type = 'admin_tenant';
create index if not exists idx_chat_landlord_tenant on chat_messages(thread_type, landlord_id, tenant_id) where thread_type = 'landlord_tenant';
create index if not exists idx_chat_created_at on chat_messages(created_at);
create index if not exists idx_chat_reply_to on chat_messages(reply_to_id);
