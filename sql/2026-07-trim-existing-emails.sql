-- =====================================================================
-- One-time cleanup: trim whitespace from emails already stored before
-- the addTenant/addManager/registerLandlord/updateMyContact fix.
--
-- Root cause: those write paths stored the email exactly as typed,
-- with no trim(), while login() also never trimmed the email on the
-- way back in. A stray leading/trailing space (very common from
-- mobile autofill or pasting out of the credentials email) meant the
-- stored value and login attempt technically didn't match, so email
-- login silently failed with "Invalid email or password" while phone
-- login kept working (phone survives this because normalizePhone()
-- strips everything down to digits regardless of spacing).
--
-- Safe to run any number of times - only touches rows that actually
-- have leading/trailing whitespace.
-- =====================================================================

update landlords
set email = trim(email)
where email is not null and email <> trim(email);

update tenants
set email = trim(email)
where email is not null and email <> trim(email);

update property_managers
set email = trim(email)
where email is not null and email <> trim(email);
