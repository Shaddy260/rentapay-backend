-- =====================================================================
-- DIRECT REQUEST: give a TENANT the same recourse against a bad-faith
-- rating that landlords already have (see add-rating-flag-for-review.sql)
-- - but on the other side of the relationship: a landlord/manager/
-- caretaker rating a tenant unfairly (e.g. retaliation after a
-- complaint, or right before a deposit dispute).
--
-- add-rating-flag-for-review.sql deliberately EXCLUDED tenant_ratings
-- from flagging, reasoning "those are written BY the landlord about a
-- tenant - the landlord doesn't need a flag path for their own
-- rating." That reasoning is correct for the LANDLORD side, but never
-- gave the TENANT (the one being rated) an equivalent path - this
-- fills that gap, symmetric to the landlord_ratings/staff_ratings/
-- property_ratings flow:
--   1. Tenant flags a rating left about them, with a reason -> the
--      rating is excluded from their portable-reputation aggregate
--      while the flag is pending, same as the landlord-side flow.
--   2. Admin reviews and resolves -> 'upheld' (goes back into the
--      aggregate) or 'removed' (stays excluded permanently).
--
-- Column shape mirrors the landlord-side columns exactly, just keyed
-- by flagged_by_tenant_id instead of flagged_by_landlord_id.
--
-- Note (attribution): unlike landlord_ratings/staff_ratings, a tenant
-- viewing their OWN tenant_ratings has always been allowed to see who
-- left each one (reputation.service.js already returns landlordName
-- per rating) - a tenant isn't at risk of "singling out" the one
-- landlord they currently have, so there was never an anonymity
-- requirement to preserve here the way there is for a landlord's pool
-- of many tenants.
-- =====================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'tenant_ratings' and column_name = 'flag_status') then
    alter table tenant_ratings add column flag_status text not null default 'none'
      check (flag_status in ('none', 'flagged', 'upheld', 'removed'));
    alter table tenant_ratings add column flagged_by_tenant_id uuid references tenants(id) on delete set null;
    alter table tenant_ratings add column flag_reason text;
    alter table tenant_ratings add column flagged_at timestamptz;
    alter table tenant_ratings add column flag_resolved_at timestamptz;
    alter table tenant_ratings add column flag_resolution_note text;
  end if;
end $$;

create index if not exists idx_tenant_ratings_flag_status on tenant_ratings(flag_status) where flag_status != 'none';

-- VERIFICATION:
--   select id, flag_status, flagged_by_tenant_id from tenant_ratings limit 1;
-- =====================================================================
