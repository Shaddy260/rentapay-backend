-- =====================================================================
-- DIRECT REQUEST: BA attribution should live on the PROPERTY, not the
-- landlord account. Today `landlords.ba_id` is set once and shared by
-- every property that landlord ever adds - a second property added
-- later with a *different* BA's referral code is silently ignored
-- (see property.controller.js's initiatePropertyPurchase, which only
-- fills ba_id when it's currently empty). That means:
--   - a landlord's whole account (all properties, past and future)
--     is permanently tied to whichever BA happened to onboard them
--     first, even if a completely different BA helps them add a
--     second, unrelated property later
--   - the BA dashboard / admin landlord search has no way to show
--     "this landlord has 2 properties, one from BA-A and one from
--     BA-B" - it only ever shows one BA per landlord
--
-- This migration adds a `ba_id` column directly to `properties` and
-- `property_payments` so each property can carry its OWN, independent
-- attribution, captured at the moment it is added (see the
-- application-layer changes in property.controller.js). Nothing here
-- changes `landlords.ba_id`, which keeps meaning exactly what it
-- means today: "which BA onboarded this landlord's original/first
-- property at signup."
--
-- No backfill: existing properties get ba_id = null (unknown/not
-- separately tracked before this migration) rather than guessing by
-- copying the landlord's ba_id onto every property they own - that
-- would misattribute a landlord's OTHER properties to whichever BA
-- happened to onboard them first, which is exactly the bug this
-- migration exists to stop doing going forward. The landlord's
-- original/day-one property is still identifiable via landlords.ba_id
-- for anyone reporting on historical data.
-- =====================================================================

alter table properties add column if not exists ba_id uuid references brand_ambassadors(id);
alter table property_payments add column if not exists ba_id uuid references brand_ambassadors(id);

-- Same qualification shape as landlords.ba_qualification_status /
-- ba_qualified_at (sql/2026-08-remove-manual-ba-claims.sql, Section C),
-- just tracked per-property instead of per-landlord-account. A
-- property with no ba_id stays irrelevant to qualification/commission
-- regardless of this status.
alter table properties add column if not exists ba_qualification_status text not null default 'pending'
  check (ba_qualification_status in ('pending', 'qualified'));
alter table properties add column if not exists ba_qualified_at timestamptz;

create index if not exists idx_properties_ba on properties(ba_id);
create index if not exists idx_property_payments_ba on property_payments(ba_id);
create index if not exists idx_properties_ba_qualification on properties(ba_id, ba_qualification_status) where ba_id is not null;

-- Lets the payout-run report (baPayoutQualificationReport.service.js)
-- show a per-property attribution row distinctly from a per-landlord-
-- signup row, same reasoning as everywhere else in this migration.
alter table ba_payout_qualification_report_entries add column if not exists property_id uuid references properties(id) on delete set null;
alter table ba_payout_qualification_report_entries add column if not exists property_name text;
