-- FEATURE (direct request): landlord can optionally key in property
-- rules & regulations as free text, per property. Visible to every
-- tenant under that property in a "Property Rules" UI shown on open
-- (see TenantPortal.jsx PropertyRulesCard). Entirely optional - null
-- means the landlord hasn't set any, in which case the tenant simply
-- never sees the rules card at all (no empty box shown).
alter table properties add column if not exists rules_text text;
