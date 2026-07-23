-- =====================================================================
-- Migration: add paid_through_date to tenants
-- =====================================================================
-- Run this once in Supabase SQL Editor against your existing database.
-- Safe to run even if you already have tenant rows - the column
-- defaults to NULL for everyone (meaning "not tracked / no prepayment
-- yet"), nothing existing breaks.

alter table tenants
  add column if not exists paid_through_date date;

-- Optional: backfill an initial value for existing active tenants
-- based on their current due date, so the feature has a sane starting
-- point rather than NULL for tenants who already existed before this
-- migration. Adjust or skip this if you'd rather start everyone fresh.
--
-- update tenants t
-- set paid_through_date = (
--   select (date_trunc('month', current_date) +
--           (coalesce(t.due_day_of_month, u.due_day_of_month) - 1) * interval '1 day')::date
--   from units u where u.id = t.unit_id
-- )
-- where t.is_active = true and t.paid_through_date is null;
