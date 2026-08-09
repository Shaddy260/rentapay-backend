-- =====================================================================
-- DIRECT REQUEST: give a landlord recourse against a rating they
-- believe is in bad faith - e.g. one aggrieved tenant tanking a
-- property's score right before move-out, or the flip side people
-- worry about with any two-sided rating system, coached/traded ratings.
-- Nothing today lets a landlord do anything but sit with either.
--
-- Scope: this applies to the three rating tables where a TENANT rates
-- someone/something the landlord has a stake in - landlord_ratings,
-- staff_ratings, property_ratings. It deliberately does NOT apply to
-- tenant_ratings, since those are written BY the landlord about a
-- tenant - the landlord doesn't need a flag path for their own rating.
--
-- Design: this is a FLAG-FOR-REVIEW path, not a landlord-side delete/
-- override button. A landlord can mark a rating as disputed and say
-- why; while a flag is pending, that single rating is excluded from
-- the aggregate (so a live dispute doesn't keep counting against them
-- while under review) but the row itself is preserved - a landlord
-- can't just unilaterally erase an inconvenient rating. An admin (or
-- future review workflow) resolves the flag to either 'upheld' (rating
-- was legitimate, counts again) or 'removed' (confirmed bad-faith,
-- stays excluded). This mirrors how disputes.controller.js already
-- separates "raise a concern" from "unilaterally win it".
-- =====================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'landlord_ratings' and column_name = 'flag_status') then
    alter table landlord_ratings add column flag_status text not null default 'none'
      check (flag_status in ('none', 'flagged', 'upheld', 'removed'));
    alter table landlord_ratings add column flagged_by_landlord_id uuid references landlords(id) on delete set null;
    alter table landlord_ratings add column flag_reason text;
    alter table landlord_ratings add column flagged_at timestamptz;
    alter table landlord_ratings add column flag_resolved_at timestamptz;
    alter table landlord_ratings add column flag_resolution_note text;
  end if;

  if not exists (select 1 from information_schema.columns where table_name = 'staff_ratings' and column_name = 'flag_status') then
    alter table staff_ratings add column flag_status text not null default 'none'
      check (flag_status in ('none', 'flagged', 'upheld', 'removed'));
    alter table staff_ratings add column flagged_by_landlord_id uuid references landlords(id) on delete set null;
    alter table staff_ratings add column flag_reason text;
    alter table staff_ratings add column flagged_at timestamptz;
    alter table staff_ratings add column flag_resolved_at timestamptz;
    alter table staff_ratings add column flag_resolution_note text;
  end if;

  if not exists (select 1 from information_schema.columns where table_name = 'property_ratings' and column_name = 'flag_status') then
    alter table property_ratings add column flag_status text not null default 'none'
      check (flag_status in ('none', 'flagged', 'upheld', 'removed'));
    alter table property_ratings add column flagged_by_landlord_id uuid references landlords(id) on delete set null;
    alter table property_ratings add column flag_reason text;
    alter table property_ratings add column flagged_at timestamptz;
    alter table property_ratings add column flag_resolved_at timestamptz;
    alter table property_ratings add column flag_resolution_note text;
  end if;
end $$;

create index if not exists idx_landlord_ratings_flag_status on landlord_ratings(flag_status) where flag_status != 'none';
create index if not exists idx_staff_ratings_flag_status on staff_ratings(flag_status) where flag_status != 'none';
create index if not exists idx_property_ratings_flag_status on property_ratings(flag_status) where flag_status != 'none';
