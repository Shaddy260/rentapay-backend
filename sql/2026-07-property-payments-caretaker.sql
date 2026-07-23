-- =====================================================================
-- Follow-up to 2026-07-property-managers.sql: the "buy a new property"
-- flow (property.controller.js initiatePropertyPurchase / purchase-
-- Property in the frontend) was still writing the pre-migration
-- manager_name / manager_phone columns on property_payments, which are
-- never read anywhere else now that properties uses caretaker_name /
-- caretaker_phone. This adds the matching caretaker columns here too
-- so a caretaker set while paying for a brand-new property actually
-- survives onto the created properties row.
-- Run this in the Supabase SQL Editor AFTER 2026-07-property-managers.sql.
-- =====================================================================
alter table property_payments add column if not exists caretaker_name text;
alter table property_payments add column if not exists caretaker_phone text;

-- The old manager_name / manager_phone columns are kept (nothing is
-- deleted per project convention) but are no longer read or written.
