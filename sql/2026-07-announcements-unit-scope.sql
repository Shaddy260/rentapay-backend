-- =====================================================================
-- Item 9: unit-scoped announcements.
--
-- Every "Unit X's rent/due date/extra charge/payment method has
-- changed" system announcement was being sent with audience='property'
-- - visible to every tenant in the whole apartment/property, not just
-- the one tenant whose unit actually changed. A rent change on Unit 4B
-- has no business showing up in Unit 2A's notification feed.
--
-- Adds a third, more specific audience level: 'unit'. Existing 'all'
-- and 'property' broadcasts (announcements sent by a landlord/manager/
-- caretaker to the whole account or one property) are untouched.
-- =====================================================================

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'announcements_audience_check') then
    alter table announcements drop constraint announcements_audience_check;
  end if;
end $$;

alter table announcements
  add constraint announcements_audience_check check (audience in ('all', 'property', 'unit'));

alter table announcements add column if not exists unit_id uuid references units(id) on delete cascade;

create index if not exists idx_announcements_unit on announcements(unit_id) where unit_id is not null;
