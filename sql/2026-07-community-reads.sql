-- =====================================================================
-- Community board/marketplace: per-reader read-tracking, so the
-- sidebar "Community Board" nav item can show an unread-count badge
-- the same way Messages/Disputes/Payment Plan Requests already do.
-- Direct request: "no notification counter on community ui... in all
-- portals... i wish there is notification counters where messages are
-- involved."
--
-- Same shape/reasoning as announcement_reads (2026-07-announcements.sql):
-- one small join-table row per (post, reader) rather than an array
-- column on the post itself, so marking read is a cheap upsert that
-- never contends with other readers doing the same thing at once.
--
-- Run this in the Supabase SQL Editor.
-- =====================================================================

create table if not exists community_post_reads (
  post_id uuid not null references community_posts(id) on delete cascade,
  reader_type text not null check (reader_type in ('tenant', 'landlord', 'manager')),
  reader_id uuid not null,
  read_at timestamptz not null default now(),
  primary key (post_id, reader_type, reader_id)
);

create index if not exists idx_community_post_reads_reader on community_post_reads(reader_type, reader_id);
