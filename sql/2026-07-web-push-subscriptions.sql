-- =====================================================================
-- Migration: Web Push subscriptions (run once in Supabase SQL Editor,
-- after 2026-07-notifications-inbox.sql).
-- =====================================================================
-- FIX: "Live push" - urgent-tier events (payment-confirmation requests,
-- vacate notices, tenant messages) should reach a landlord/manager/
-- tenant even when the portal tab isn't open, via the browser's native
-- push notification. Everything else keeps updating quietly in-app
-- only (the existing `notifications` table), no OS-level push.
--
-- One row per browser/device a user has granted notification
-- permission on and registered a service worker for. A single account
-- can have several rows (phone + laptop, etc.) - all are pushed to.
-- =====================================================================

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),

  recipient_type text not null check (recipient_type in ('landlord', 'manager', 'tenant')),
  recipient_id uuid not null,

  endpoint text not null unique,
  p256dh text not null,
  auth text not null,

  created_at timestamptz default now()
);

create index if not exists idx_push_subscriptions_recipient
  on push_subscriptions(recipient_type, recipient_id);
