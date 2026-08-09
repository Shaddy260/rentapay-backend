-- =====================================================================
-- FEATURE (direct request: onboarding tour "despite the role" - every
-- account type currently looks identical on day 1 and on day 500,
-- with zero first-run guidance). This adds one nullable timestamp per
-- role table: null means "still show the getting-started checklist",
-- set means "this person dismissed it (or it auto-hid once every step
-- was naturally done) - never show it again automatically."
--
-- Deliberately NOT a per-step "completed steps" table: each step's
-- done/not-done state is derived live from real data the person
-- already has (e.g. "added a property" is true the moment a row
-- exists in `properties` - see OnboardingChecklist.jsx) rather than a
-- manually-ticked checkbox that could drift out of sync with reality.
-- This column only tracks the "hide the whole card" decision.
-- =====================================================================

alter table landlords add column if not exists onboarding_dismissed_at timestamptz;
alter table tenants add column if not exists onboarding_dismissed_at timestamptz;
alter table scouts add column if not exists onboarding_dismissed_at timestamptz;
alter table property_managers add column if not exists onboarding_dismissed_at timestamptz;
