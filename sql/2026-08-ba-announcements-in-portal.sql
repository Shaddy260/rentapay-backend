-- BA-scoped in-portal Announcements
-- ---------------------------------------------------------------------
-- Brand ambassadors could already receive announcement broadcasts via
-- SMS/push (notify() already handles recipient_type = 'brand_ambassador'
-- for both `notifications` and `push_subscriptions` - see
-- add-brand-ambassador-profile-photo-and-push.sql and
-- 2026-08-payout-rules-qualification.sql), but had no way to see those
-- same broadcasts inside the BA portal itself, because:
--   1. GET /announcements (and the read/delete endpoints) rejected the
--      'brand_ambassador' role entirely (see announcement.routes.js).
--   2. Even if allowed through, `announcement_reads` and
--      `announcement_hidden` only accepted recipient_type in
--      ('tenant', 'manager', 'landlord') - a BA's read/hide upsert
--      would have failed the CHECK constraint.
-- This migration only needs to touch those two tables - `announcements`
-- itself has no recipient_type column, and `notifications` /
-- `push_subscriptions` already allow 'brand_ambassador' from earlier
-- migrations.
-- ---------------------------------------------------------------------

alter table announcement_reads drop constraint if exists announcement_reads_recipient_type_check;
alter table announcement_reads add constraint announcement_reads_recipient_type_check
  check (recipient_type in ('tenant', 'manager', 'landlord', 'brand_ambassador'));

alter table announcement_hidden drop constraint if exists announcement_hidden_recipient_type_check;
alter table announcement_hidden add constraint announcement_hidden_recipient_type_check
  check (recipient_type in ('tenant', 'manager', 'landlord', 'brand_ambassador'));
