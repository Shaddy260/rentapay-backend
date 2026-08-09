-- =====================================================================
-- DIRECT REQUEST: tenant_ratings previously only distinguished ratings
-- by the *landlord account* (landlord_id) - a manager and a landlord
-- rating the same tenant just overwrote the same row, and a caretaker
-- was blocked from rating a tenant at all. The tenant details view
-- needs to show three separate breakdowns - "Landlord ratings",
-- "Manager ratings", "Caretaker ratings" - so the row itself now
-- needs to know which of those three the rating came from.
-- =====================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'tenant_ratings' and column_name = 'rater_role') then
    alter table tenant_ratings add column rater_role text not null default 'landlord'
      check (rater_role in ('landlord', 'manager', 'caretaker'));
  end if;
end $$;

-- Old unique index was (landlord_id, tenant_email, category) - one
-- row per landlord account per category, so a manager's rating and
-- the landlord's own rating collided. Replace with rater_role
-- included, so each role keeps its own row per category, while still
-- collapsing repeat ratings from the SAME role (e.g. the landlord
-- updates their own "payment" rating) rather than growing unbounded
-- from every individual manager/caretaker login.
drop index if exists uq_tenant_rating_landlord_email_category;
create unique index if not exists idx_tenant_ratings_unique_per_role_category
  on tenant_ratings(landlord_id, tenant_email, category, rater_role);

create index if not exists idx_tenant_ratings_rater_role on tenant_ratings(rater_role);

-- VERIFICATION:
--   select tenant_email, category, rater_role, rating from tenant_ratings limit 5;
-- =====================================================================
