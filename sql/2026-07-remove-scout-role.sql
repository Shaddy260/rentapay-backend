-- =====================================================================
-- REMOVE SCOUT ROLE - full teardown
--
-- The Scout role/portal has been removed from the app code and
-- replaced by the free "list units publicly" feature
-- (units.is_publicly_listed, see add-unit-public-listing-toggle.sql).
-- This migration undoes every schema change ever made across:
--   add-scout-role.sql
--   add-scout-help-and-announcements.sql
--   add-scout-password-reset-role.sql
--   add-scout-payments.sql
--   add-scout-profile-photo.sql
--   add-scout-push-notifications.sql
--   add-scout-referral-payouts.sql
--   add-scout-referrals.sql
--   2026-07-scout-exclusivity-and-constituency.sql (scout part only)
--   2026-07-scout-lead-pipeline.sql
--   2026-07-scout-leaderboard-index.sql
--
-- Run this ONCE in the Supabase SQL Editor. Order matters: tables that
-- reference scouts(id) are dropped/altered before scouts itself, and
-- every check constraint that was widened to include 'scout' is put
-- back to its pre-Scout list of allowed values.
--
-- units.last_verified_at is KEPT - it predates and is independent of
-- Scout (used by the ordinary "Still vacant - confirm" flow), even
-- though it was introduced in add-scout-referrals.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Drop Scout-only tables (children first).
-- ---------------------------------------------------------------------
drop index if exists idx_scout_referrals_scout_status;
drop table if exists scout_referrals cascade;
drop table if exists scout_county_payments cascade;
drop table if exists scout_manual_county_payments cascade;
drop table if exists scout_county_subscriptions cascade;
drop table if exists blocked_scouts cascade;
drop table if exists county_pricing_tiers cascade;
drop table if exists scouts cascade;

-- ---------------------------------------------------------------------
-- 2) chat_messages / chat_message_hidden - drop scout columns and put
--    every widened constraint back to its pre-Scout shape.
-- ---------------------------------------------------------------------
drop index if exists idx_chat_scout_landlord;

alter table chat_messages drop column if exists scout_id;
alter table chat_messages drop column if exists read_by_scout;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_thread_type_check') then
    alter table chat_messages drop constraint chat_messages_thread_type_check;
  end if;
end $$;
alter table chat_messages
  add constraint chat_messages_thread_type_check
  check (thread_type in ('admin_landlord', 'admin_tenant', 'landlord_tenant'));

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_thread_shape') then
    alter table chat_messages drop constraint chat_messages_thread_shape;
  end if;
end $$;
alter table chat_messages
  add constraint chat_messages_thread_shape check (
    (thread_type = 'admin_landlord'  and landlord_id is not null and tenant_id is null) or
    (thread_type = 'admin_tenant'    and tenant_id is not null) or
    (thread_type = 'landlord_tenant' and landlord_id is not null and tenant_id is not null)
  );

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_sender_role_check') then
    alter table chat_messages drop constraint chat_messages_sender_role_check;
  end if;
end $$;
alter table chat_messages
  add constraint chat_messages_sender_role_check
  check (sender_role in ('admin', 'landlord', 'manager', 'tenant'));

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_deleted_by_role_check') then
    alter table chat_messages drop constraint chat_messages_deleted_by_role_check;
  end if;
end $$;
alter table chat_messages
  add constraint chat_messages_deleted_by_role_check
  check (deleted_by_role in ('admin', 'landlord', 'manager', 'tenant'));

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_message_hidden_viewer_role_check') then
    alter table chat_message_hidden drop constraint chat_message_hidden_viewer_role_check;
  end if;
end $$;
alter table chat_message_hidden
  add constraint chat_message_hidden_viewer_role_check
  check (viewer_role in ('admin', 'landlord', 'manager', 'tenant'));

-- ---------------------------------------------------------------------
-- 3) landlords - drop scout-visibility columns.
-- ---------------------------------------------------------------------
alter table landlords drop column if exists scout_visibility_enabled;
alter table landlords drop column if exists scout_disclosure_seen_at;

-- ---------------------------------------------------------------------
-- 4) help_requests / notifications / announcement_reads /
--    announcement_hidden / announcements - remove 'scout' from every
--    widened check constraint.
-- ---------------------------------------------------------------------
alter table help_requests drop constraint if exists help_requests_requester_type_check;
alter table help_requests add constraint help_requests_requester_type_check
  check (requester_type in ('landlord', 'tenant', 'guest'));

alter table notifications drop constraint if exists notifications_recipient_type_check;
alter table notifications add constraint notifications_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant'));

alter table announcement_reads drop constraint if exists announcement_reads_recipient_type_check;
alter table announcement_reads add constraint announcement_reads_recipient_type_check
  check (recipient_type in ('tenant', 'manager', 'landlord'));

alter table announcement_hidden drop constraint if exists announcement_hidden_recipient_type_check;
alter table announcement_hidden add constraint announcement_hidden_recipient_type_check
  check (recipient_type in ('tenant', 'manager', 'landlord'));

alter table announcements drop constraint if exists announcements_platform_target_group_check;
alter table announcements add constraint announcements_platform_target_group_check
  check (platform_target_group in ('all', 'tenants', 'landlord_team'));

-- ---------------------------------------------------------------------
-- 5) push_subscriptions - remove 'scout'.
-- ---------------------------------------------------------------------
alter table push_subscriptions drop constraint if exists push_subscriptions_recipient_type_check;
alter table push_subscriptions add constraint push_subscriptions_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant'));

-- ---------------------------------------------------------------------
-- 6) password_reset_requests - remove 'scout'.
-- ---------------------------------------------------------------------
alter table password_reset_requests drop constraint if exists password_reset_requests_role_check;
alter table password_reset_requests
  add constraint password_reset_requests_role_check
  check (role in ('landlord', 'tenant', 'manager', 'caretaker'));

-- =====================================================================
-- CLEANUP (optional, data hygiene only - safe to skip): any rows that
-- were left behind by a scout in the still-shared tables above have
-- already been made constraint-invalid by the changes above, so they
-- would only cause a problem if something tries to UPDATE them later
-- without also changing recipient_type/sender_role away from 'scout'.
-- Since inserts/updates of 'scout' rows are no longer possible after
-- this migration, and the app code no longer writes them, no further
-- action is required - existing historical 'scout' rows (if any) in
-- notifications/help_requests/announcement_reads etc. simply become
-- inert history. Delete them by hand only if you specifically want
-- them gone:
--
--   delete from notifications where recipient_type = 'scout';
--   delete from help_requests where requester_type = 'scout';
--   delete from announcement_reads where recipient_type = 'scout';
--   delete from announcement_hidden where recipient_type = 'scout';
-- =====================================================================

-- =====================================================================
-- VERIFICATION - run after the above and eyeball the output:
--
--   select table_name from information_schema.tables
--     where table_name in ('scouts','scout_county_subscriptions','county_pricing_tiers',
--                           'blocked_scouts','scout_referrals','scout_county_payments',
--                           'scout_manual_county_payments');
--   -- should return ZERO rows
--
--   select column_name from information_schema.columns
--     where table_name = 'landlords' and column_name in ('scout_visibility_enabled','scout_disclosure_seen_at');
--   -- should return ZERO rows
--
--   select column_name from information_schema.columns
--     where table_name = 'chat_messages' and column_name in ('scout_id','read_by_scout');
--   -- should return ZERO rows
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'chat_messages'::regclass and contype = 'c';
--   -- none of the definitions should mention 'scout'
-- =====================================================================
