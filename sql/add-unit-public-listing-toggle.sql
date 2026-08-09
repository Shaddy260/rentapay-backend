-- ADD: units.is_publicly_listed
--
-- DIRECT REQUEST: "add an option in the landlord/manager portal that
-- they choose whether their vacant units should be listed public or
-- not." Previously every vacant unit automatically appeared on the
-- no-login /find-a-house public listings page with no way to opt
-- out - some landlords/managers want to fill a vacancy privately
-- (word of mouth, an existing waiting list, a specific agent) without
-- it being visible to anyone who opens that page.
--
-- Defaults to true so existing behavior (every vacant unit is public)
-- is unchanged for everyone until they explicitly flip it off.
alter table units add column if not exists is_publicly_listed boolean not null default true;

create index if not exists idx_units_public_listing on units(status, is_publicly_listed);
