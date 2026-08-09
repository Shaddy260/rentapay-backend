-- =====================================================================
-- BUILD SPEC PHASE 20 - Notification Batching & Rate-Limiting.
--
-- A lightweight queue this phase's batching layer (see
-- src/services/notificationBatch.service.js) reads and writes. It
-- does NOT touch any table from earlier phases - qualification
-- writes, payout marks, and BA report content all still land exactly
-- where they always did. This table only tracks the *alert/ping*
-- side of a notification so it can be combined when several land for
-- the same recipient in a short window, per the Phase 20 spec.
--
-- One row per queued event. `flushed_at` is set the moment that
-- event has been delivered - either immediately (it was the only
-- thing queued for that recipient+stream) or later as part of a
-- combined message when the periodic flush job runs. Nothing is ever
-- deleted, so the table doubles as a small audit trail of what was
-- batched together and when.
-- =====================================================================

create table if not exists notification_batch_queue (
  id uuid primary key default gen_random_uuid(),
  -- Matches notifications.recipient_type/recipient_id conventions
  -- (recipient_id is text, not uuid, to allow the literal
  -- 'super-admin' actor id used throughout - see notify.service.js).
  recipient_type text not null,
  recipient_id text not null,
  -- Groups events that should be combined together at flush time.
  -- Currently used: 'ba_alert' (Phase 10 qualification/tier-crossed
  -- alerts to a BA) and 'admin_ba_report_ping' (Phase 7 BA-report
  -- ping to admin). Deliberately free-text, not a check constraint,
  -- so a future stream can be added without a migration.
  batch_key text not null,
  event_type text not null,
  -- Short human-readable summary of this one event, used to build
  -- the combined message at flush time (e.g. "2 landlords qualified",
  -- a BA's full name for a report ping).
  fragment text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  flushed_at timestamptz
);

-- Every "is anything already queued for this recipient+stream?" check
-- and every flush pass filters on exactly this shape, and only ever
-- cares about rows that haven't flushed yet.
create index if not exists idx_notification_batch_queue_pending
  on notification_batch_queue (recipient_type, recipient_id, batch_key)
  where flushed_at is null;

create index if not exists idx_notification_batch_queue_flush_pass
  on notification_batch_queue (batch_key, created_at)
  where flushed_at is null;
