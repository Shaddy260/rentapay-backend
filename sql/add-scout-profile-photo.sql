-- =====================================================================
-- Direct request: "scout portal is so boring...they should have a
-- profile like other portals, be able to set their own profile...like
-- in others". Landlords/tenants/managers already have a photo_url
-- column (see add-photo-url.sql / 2026-07-property-managers.sql) that
-- AccountMenu.jsx's "Update profile picture" reads/writes - scouts
-- never got the equivalent column, so there was no way for a scout's
-- own upload to ever be saved even once the rest of the plumbing (see
-- upload.controller.js's tableForRole fix alongside this migration)
-- was corrected.
-- =====================================================================

alter table scouts add column if not exists photo_url text;

-- Optional short "operating area / about" blurb a scout can show
-- landlords/tenants they message - purely descriptive, not used in any
-- matching logic. Mirrors the freeform bio-style fields other portals
-- have (e.g. landlords.gender is informational-only in the same way).
alter table scouts add column if not exists bio text;
