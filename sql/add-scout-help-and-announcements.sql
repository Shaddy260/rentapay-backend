-- =====================================================================
-- Migration: Scout help requests + platform announcements (Pass 2,
-- item 2). Run once in Supabase SQL Editor, after add-scout-role.sql
-- and 2026-07-updates-v3.sql / add-platform-message-targeting.sql.
-- =====================================================================
-- FIX: a Scout had no way to submit a help request, appear in an
-- admin-side help-request queue, receive an in-portal notification, or
-- be targeted by an admin platform-wide broadcast - every one of these
-- was gated by a check constraint that only knew about
-- landlord/tenant/manager/guest. This widens each of them the same way
-- add-scout-role.sql widened chat_messages, so 'scout' rows are valid
-- before the app tries to write them. No new tables - Scouts reuse the
-- exact same help_requests / notifications / announcements machinery
-- everyone else already uses.
-- =====================================================================

-- Scouts can now submit help requests (ComplaintsPanel, reused as-is
-- in the Scout portal) and appear in the admin help-request queue.
alter table help_requests drop constraint if exists help_requests_requester_type_check;
alter table help_requests add constraint help_requests_requester_type_check
  check (requester_type in ('landlord', 'tenant', 'guest', 'scout'));

-- Scouts can now receive in-portal notification-inbox rows (used by
-- notify(), e.g. when a platform announcement is fanned out to them).
alter table notifications drop constraint if exists notifications_recipient_type_check;
alter table notifications add constraint notifications_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant', 'scout'));

-- Scouts can now mark platform announcements read / hide them for
-- themselves, same as every other role.
alter table announcement_reads drop constraint if exists announcement_reads_recipient_type_check;
alter table announcement_reads add constraint announcement_reads_recipient_type_check
  check (recipient_type in ('tenant', 'manager', 'landlord', 'scout'));

alter table announcement_hidden drop constraint if exists announcement_hidden_recipient_type_check;
alter table announcement_hidden add constraint announcement_hidden_recipient_type_check
  check (recipient_type in ('tenant', 'manager', 'landlord', 'scout'));

-- Admin's platform-wide broadcast gets a fourth target-group option -
-- Scouts are their own audience, not part of "tenants" or the
-- landlord/manager/caretaker "landlord_team" group, and were
-- previously only reachable via 'all' (or not reachable at all, since
-- fanOutAnnouncementPush didn't query scouts under any group).
alter table announcements drop constraint if exists announcements_platform_target_group_check;
alter table announcements add constraint announcements_platform_target_group_check
  check (platform_target_group in ('all', 'tenants', 'landlord_team', 'scouts'));
