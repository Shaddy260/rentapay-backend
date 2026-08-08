-- Adds the column the new monthly billing job uses to make sure a
-- tenant is only ever billed once per calendar period (prevents
-- double-charging if the job runs more than once on the same day, or
-- catches up after downtime).
--
-- paid_through_date is intentionally left in place (harmless, just
-- unused going forward) rather than dropped, so no historical data is
-- lost. balance_due is now the single source of truth for what a
-- tenant owes/has as credit; see src/utils/prepayment.js.

alter table tenants add column if not exists last_billed_period text;

-- One-time backfill: for tenants who already have an active billing
-- cycle (move-in date in the past, due day already passed this
-- month), mark them as billed for the current period so the first
-- run of the new job doesn't double-charge on top of whatever
-- balance_due already reflects from the old system. Adjust the month
-- below to match whenever you actually run this migration.
update tenants
set last_billed_period = to_char(now(), 'YYYY-MM')
where is_active = true
  and last_billed_period is null
  and extract(day from now()) >= coalesce(due_day_of_month, (select due_day_of_month from units where units.id = tenants.unit_id));
