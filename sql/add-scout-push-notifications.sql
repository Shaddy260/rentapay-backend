-- =====================================================================
-- Migration: Scout push notifications (run once in Supabase SQL
-- Editor, after 2026-07-web-push-subscriptions.sql and
-- add-scout-role.sql).
-- =====================================================================
-- FIX (Pass 2, item 3 - "Scout push notifications"): push_subscriptions
-- previously only recognized recipient_type of 'landlord' / 'manager' /
-- 'tenant', so a Scout had no way to register for live push at all -
-- the frontend call would succeed (nothing validates recipient_type on
-- write besides this constraint) but a Scout's push.controller.js
-- recipientFor() branch didn't exist, so nothing to check yet. This
-- widens the constraint the same way add-scout-role.sql widened
-- chat_messages/every other cross-role check constraint in this
-- codebase, so 'scout' rows are actually valid before the app tries to
-- write them.
-- =====================================================================

alter table push_subscriptions drop constraint if exists push_subscriptions_recipient_type_check;
alter table push_subscriptions add constraint push_subscriptions_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant', 'scout'));
