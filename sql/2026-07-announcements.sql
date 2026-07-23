-- =====================================================================
-- Announcements: a landlord broadcasts a message to everyone attached
-- to their account (tenants, property managers, caretakers). Shown as
-- a bell icon with an unread count in every portal (except admin).
--
-- One row per announcement. Read state is tracked per-recipient in a
-- small join table rather than one big array column, so "mark as
-- read" is a simple upsert and doesn't require rewriting the whole
-- announcement row (avoids write contention if many tenants open it
-- around the same time).
--
-- Run this in the Supabase SQL Editor after the other migrations in
-- this folder.
-- =====================================================================

create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  message text not null,
  -- Who this was sent to: 'all' (everyone), or a specific property, so
  -- a landlord can message just one apartment's tenants if they want.
  -- NULL property_id + audience 'all' = literally everyone.
  property_id uuid references properties(id) on delete cascade,
  audience text not null default 'all' check (audience in ('all', 'property')),
  -- System-generated announcements (e.g. "payment method changed") are
  -- flagged so the UI can style them slightly differently if desired,
  -- and so they're excluded from any "delete my announcement" UI later.
  is_system boolean default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_announcements_landlord on announcements(landlord_id, created_at desc);

-- Tracks who has read which announcement. recipient_type distinguishes
-- id collisions across tenants/property_managers (both use uuid pk's
-- from different tables, so in practice collisions are astronomically
-- unlikely, but being explicit costs nothing and avoids ever trusting
-- an id in isolation).
create table if not exists announcement_reads (
  announcement_id uuid not null references announcements(id) on delete cascade,
  recipient_type text not null check (recipient_type in ('tenant', 'manager', 'landlord')),
  recipient_id uuid not null,
  read_at timestamptz not null default now(),
  primary key (announcement_id, recipient_type, recipient_id)
);
