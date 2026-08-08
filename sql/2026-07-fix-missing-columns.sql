-- =====================================================================
-- Migration: fix two columns missing from the live database
-- (2026-07-fix-missing-columns.sql)
-- =====================================================================
-- WHY THIS FILE EXISTS:
--
-- Both columns below are already defined in their original migration
-- files (add-unit-listing-description.sql, and community_post_replies
-- inside 2026-07-community-board.sql). But those tables already
-- existed on the live database BEFORE those columns were added to the
-- migration files - and `create table if not exists` is a no-op on a
-- table that already exists, so re-running the original files does
-- NOT retroactively add a missing column to an existing table. That's
-- exactly why these two errors were showing up in production logs:
--
--   [public] listVacantUnits error: column units.listing_description does not exist
--   [community] deleteReply error: Could not find the 'deleted_by_role' column of 'community_post_replies' in the schema cache
--
-- This file is a standalone, idempotent patch - safe to run any number
-- of times, and safe even if one or both columns already exist.
-- =====================================================================

alter table units
  add column if not exists listing_description text;

alter table community_post_replies
  add column if not exists deleted_by_role text
  check (deleted_by_role in ('landlord', 'manager', 'tenant'));

-- After running this, Supabase's PostgREST schema cache needs to
-- notice the new columns. It usually picks this up automatically
-- within a few seconds/minutes, but if the same errors persist right
-- after running this, force an immediate reload with:
--
--   select pg_notify('pgrst', 'reload schema');
--
-- (Supabase's SQL Editor -> "New query" -> run that single line -
-- this is the same signal Supabase's own dashboard "Reload schema
-- cache" button sends.)
select pg_notify('pgrst', 'reload schema');
