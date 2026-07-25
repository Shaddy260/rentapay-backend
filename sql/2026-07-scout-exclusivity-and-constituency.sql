-- =====================================================================
-- 1) Landlord constituency, alongside the existing county field.
--    Same setup-wizard step (blueprint 3.2) as county - required going
--    forward, so a landlord's location can be filtered by county AND
--    constituency, not just county. Mirrors properties.county's
--    per-property version below.
-- =====================================================================
alter table landlords add column if not exists constituency text;
alter table properties add column if not exists constituency text;
alter table property_payments add column if not exists constituency text;

-- =====================================================================
-- 2) SCOUT EXCLUSIVITY (app-code change, documented here for the
--    record - no schema change was required for this part since
--    scouts was always its own table with its own unique phone index;
--    the enforcement lives in src/utils/phoneUniqueness.js and
--    src/controllers/scout.controller.js). A Scout account can no
--    longer share a phone number with a landlord/manager/tenant
--    account. This does NOT retroactively touch any existing rows -
--    if a dual-role account already exists in this environment from
--    before the change, it keeps working via the login() account
--    picker; only NEW registrations are blocked from creating another.
--    Run this query to check whether any such accounts exist and
--    decide by hand what (if anything) to do about them:
--
--   select s.id as scout_id, s.phone, l.id as landlord_id
--     from scouts s join landlords l on l.phone = s.phone
--   union all
--   select s.id, s.phone, pm.id
--     from scouts s join property_managers pm on pm.phone = s.phone
--   union all
--   select s.id, s.phone, t.id
--     from scouts s join tenants t on t.primary_phone = s.phone and t.is_active = true;
-- =====================================================================
