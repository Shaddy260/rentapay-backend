-- =====================================================================
-- 2026-07-tenant-lists-and-whatsapp-group.sql
--
-- Supports the new tenant-list Excel export (per-apartment tenant
-- list, joined-in-month, left-in-month, left-all-time) and the
-- "Add to WhatsApp Group" tab on that export.
--
-- 1. tenants.left_at - move_in_date already tracks when someone
--    joined; nothing previously tracked WHEN a tenant was archived/
--    removed/vacated, only that they currently are (is_active=false).
--    Set by tenant.controller.js deleteTenant() at the moment a
--    tenant is archived, so "left in June 2026" / "left, all time"
--    lists have a real date to filter and sort on. Existing archived
--    rows are backfilled to updated_at as a best-effort estimate.
--
-- 2. properties.whatsapp_group_id - the WhatsApp group chat id once a
--    group has been created for a given apartment's tenant list, so
--    "Add to WhatsApp Group" adds new tenants to the SAME group next
--    time instead of creating a duplicate group on every use.
--
-- Safe to run multiple times (every statement is guarded).
-- =====================================================================

alter table tenants add column if not exists left_at timestamptz;
update tenants set left_at = updated_at where is_active = false and left_at is null;

create index if not exists idx_tenants_left_at on tenants(left_at);
create index if not exists idx_tenants_move_in_date on tenants(move_in_date);

alter table properties add column if not exists whatsapp_group_id text;
