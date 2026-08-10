-- =====================================================================
-- BRAND AMBASSADOR - manual landlord log: email matching (BA fixes item 7)
--
-- The manual "Log landlord" form previously only took phone as the
-- identifier. Adds an email column alongside submitted_phone so a BA
-- can supply either/both, and submitLandlordClaim can match a real
-- landlord account by phone OR email.
-- =====================================================================

alter table ba_landlord_claims add column if not exists submitted_email text;
