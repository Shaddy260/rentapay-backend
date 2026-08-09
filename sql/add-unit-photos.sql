-- =====================================================================
-- FEATURE (direct request: "features to improve appearance and
-- functionality"): units had no photo support at all - a scout
-- browsing vacant units (see ScoutVacancies.jsx) only ever saw text
-- (name, rent, location), which is a real trust/click-through gap for
-- a rental marketplace. Stored as a jsonb array (up to 5 URLs,
-- enforced in upload.controller.js) rather than a single photo_url,
-- mirroring the existing extra_charges jsonb-array pattern already
-- used on this same table.
--
-- ALSO REQUIRES a one-time manual step: create a public Storage
-- bucket named "unit-photos" in the Supabase dashboard (Storage ->
-- New bucket -> name it exactly "unit-photos" -> toggle "Public
-- bucket" on), same as the existing "profile-photos" bucket.
-- =====================================================================

alter table units add column if not exists photo_urls jsonb default '[]'::jsonb;
