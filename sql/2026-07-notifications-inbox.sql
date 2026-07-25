-- =====================================================================
-- Migration: in-portal notifications inbox (run once in Supabase SQL
-- Editor, after the other 2026-07-*.sql migrations).
-- =====================================================================
-- FIX: "when sending any reminder, be it bulk or any updates or
-- announcements, the message should be sent to the tenant's phone
-- number as well as the portal's inbox."
--
-- chat_messages (add-chat-messages.sql) is a two-party thread between
-- a specific admin/landlord/tenant pair - it's the wrong shape for a
-- one-way system notification that should show up in EVERY relevant
-- portal's inbox regardless of who's chatting with whom. This is a
-- separate, simple one-way notifications table instead: every SMS the
-- system already sends (rent reminders, overdue alerts, bulk
-- reminders, announcements, manager/caretaker changes, etc.) now also
-- writes one row here, and the portals show it under a bell/inbox
-- icon. Nothing about chat_messages changes.
-- =====================================================================

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),

  recipient_type text not null check (recipient_type in ('landlord', 'manager', 'tenant')),
  recipient_id uuid not null,

  title text not null,
  body text not null,

  category text default 'general', -- 'rent_reminder' | 'overdue' | 'announcement' | 'account' | 'general'

  read_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_notifications_recipient on notifications(recipient_type, recipient_id, created_at desc);
create index if not exists idx_notifications_unread on notifications(recipient_type, recipient_id) where read_at is null;
