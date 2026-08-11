-- =====================================================================
-- Consolidated Change Instructions - Section F
--
-- Rebuilds the "Payout Run" report (ba_payout_qualification_reports /
-- ba_payout_qualification_report_entries, generated via POST
-- /api/brand-ambassadors/payout-qualification-reports/generate) to be
-- CYCLE-SCOPED and MONEY-AWARE, reading from ba_commission_earnings
-- (Section E) and landlords.ba_qualification_status (Section C)
-- instead of the now-dropped ba_landlord_claims table.
--
-- A run is generated for one billing cycle (periodKey = 'YYYY-MM',
-- e.g. '2026-08'), grouped by Brand Ambassador. Per BA:
--   - count of qualifying landlords with a completed payment in the
--     cycle (i.e. that BA earned commission on)
--   - count of non-qualifying landlords on their roster (visibility
--     only, no payout)
--   - per-landlord: payment amount, the percentage rate that actually
--     applied (may differ per landlord if a rate changed mid-cycle or
--     a BA override exists), and the resulting commission
--   - BA's total owed for the run = sum of the above
--
-- The old region-grouping (landlord county) is dropped as a top-level
-- concept - Section F's replacement spec groups by BA only ("Lists
-- every BA, and under each, every landlord..."). The `region` column
-- is kept (nullable, landlord's county) purely as an informational
-- field on each entry, not a grouping key.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Report header: add a money total; period_type is now always
--    'month' (a billing cycle) going forward, but the column/check is
--    left in place rather than narrowed, in case a future 'custom'
--    range is added.
-- ---------------------------------------------------------------------
alter table ba_payout_qualification_reports
  add column if not exists totals_amount_owed numeric(14,2) not null default 0;

-- ---------------------------------------------------------------------
-- 2. Entries: region becomes informational/nullable (no longer a
--    grouping key), and gain the money columns Section F's per-
--    landlord row needs. `qualifies` now means "qualifying AND had a
--    completed payment in this cycle" (i.e. earned commission this
--    run) - non-qualifying/no-payment landlords are still listed for
--    visibility, per the spec, just with no payout figures.
-- ---------------------------------------------------------------------
alter table ba_payout_qualification_report_entries
  alter column region drop not null,
  alter column region drop default;

alter table ba_payout_qualification_report_entries
  add column if not exists payment_amount numeric(12,2),
  add column if not exists percentage_applied numeric(5,2),
  add column if not exists commission_amount numeric(12,2),
  add column if not exists paid_at timestamptz;

-- =====================================================================
-- End of Section F migration. After this runs, the Payout Run report
-- (baPayoutQualificationReport.service.js) is grouped by Brand
-- Ambassador for a selected billing cycle, sourced from
-- ba_commission_earnings + landlords, with real KES amounts and the
-- rate applied per landlord's payment.
-- =====================================================================
