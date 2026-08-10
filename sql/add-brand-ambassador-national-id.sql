-- =====================================================================
-- BRAND AMBASSADOR - national ID capture (BA fixes item 6)
--
-- The self-fill onboarding form previously only asked for
-- name/phone/email. A national ID number is required for identity
-- verification and payouts, so it's now a required field on the
-- application itself.
--
-- Nullable at the DB level (existing rows predate this field and
-- must not break), but submitBaOnboarding enforces it as required
-- for every new application going forward.
-- =====================================================================

alter table brand_ambassadors add column if not exists national_id text;

-- Same "excluding rejected" pattern as the phone/email uniqueness
-- indexes in add-brand-ambassador-role.sql - a rejected applicant's
-- old national_id must never block a later legitimate application
-- (their own re-application, or someone else's, in the rare case the
-- ID was mistyped on the rejected row).
create unique index if not exists brand_ambassadors_national_id_active_uidx
  on brand_ambassadors (national_id) where status <> 'rejected' and national_id is not null;
