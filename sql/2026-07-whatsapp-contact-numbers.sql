-- =====================================================================
-- FEATURE (direct request): public vacant-unit listings need a number
-- to contact that ISN'T the login/OTP phone on the account - a
-- landlord/manager may not want their private line handed to every
-- stranger browsing listings. This adds a separate, publicly-
-- displayable WhatsApp number for landlords and property managers.
-- Caretakers already have properties.caretaker_phone (contact-only,
-- no login) - that column is reused as their WhatsApp number, no new
-- column needed there.
--
-- Nullable at the DB level (existing accounts have none yet) -
-- "mandatory" is enforced in the app: required on the landlord
-- registration form and the add-manager form going forward, and
-- backfilled from the login phone below so nothing is blank/broken
-- for accounts created before this migration ran.
-- =====================================================================

alter table landlords add column if not exists whatsapp_number text;
alter table property_managers add column if not exists whatsapp_number text;

-- Backfill: existing accounts had no chance to set this, so default it
-- to their login phone rather than leaving public listings with no
-- contact number at all. Landlords/managers can change it any time
-- from Settings.
update landlords set whatsapp_number = phone where whatsapp_number is null;
update property_managers set whatsapp_number = phone where whatsapp_number is null;
