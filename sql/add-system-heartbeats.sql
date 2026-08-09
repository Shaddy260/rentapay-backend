-- =====================================================================
-- SYSTEM HEARTBEATS - lightweight watchdog table.
--
-- Referenced by the BA build spec ("Background jobs report into the
-- existing heartbeat/watchdog system") as if it already existed in
-- this codebase - it did not, so it's added here as part of Phase 2,
-- since the stale-application reminder job (baStaleApplicationReminder
-- .job.js) is the first job that needs it. Every job that registers
-- here upserts its own row keyed by job_name on every run, so "has
-- this job run recently" is a single, cheap point lookup rather than
-- scanning a growing log table. Phase 10's qualification job should
-- register against this same table when it's built.
-- =====================================================================

create table if not exists system_heartbeats (
  job_name text primary key,
  last_run_at timestamptz not null default now(),
  last_status text not null default 'ok' check (last_status in ('ok', 'error')),
  last_error text,
  last_duration_ms int,
  updated_at timestamptz not null default now()
);
