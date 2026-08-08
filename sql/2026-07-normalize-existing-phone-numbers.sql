-- =====================================================================
-- ROOT CAUSE (direct report: "login by email works, login by phone
-- doesn't, across all users"): backend/src/utils/phone.js normalizes
-- phone numbers into one canonical shape (2547XXXXXXXX / 2541XXXXXXXX)
-- on every WRITE and every LOOKUP going forward - but that function
-- was added after a lot of accounts already existed. Their phone
-- numbers are still sitting in the DB in whatever raw format they
-- were originally typed in (0712345678, +254712345678, 712345678,
-- etc). Login normalizes what the person TYPES, then does an exact
-- string match (`.eq(phoneField, normalizedPhone)`) against the
-- STORED value - so unless the stored value happens to already be in
-- 2547XXXXXXXX form, phone login for that account can never succeed,
-- no matter what format the person types it in. Email login is
-- unaffected because email needs no such transformation (case-
-- insensitive match only), which is exactly why "email works, phone
-- doesn't" tracks with account age, not with any particular user.
--
-- This is a one-time backfill: normalize every existing phone value
-- already in the DB to the same canonical form the app now enforces
-- on write, using the exact same rules as normalizePhone():
--   strip spaces/dashes/parens -> strip leading '+' -> strip a
--   leading '254' or a leading '0' -> require the remaining 9 digits
--   to start with 7 or 1 -> prefix with '254'.
-- Anything that doesn't match a recognizable Kenyan mobile shape is
-- left untouched rather than guessed at (same "return null, let the
-- caller validate" philosophy as the JS version - we don't want to
-- silently corrupt a malformed number into a wrong-but-valid-looking
-- one).
-- =====================================================================

create or replace function _rentapay_normalize_phone(raw text)
returns text
language plpgsql
immutable
as $$
declare
  digits text;
begin
  if raw is null then
    return null;
  end if;

  digits := regexp_replace(trim(raw), '[\s\-\(\)]', '', 'g');
  digits := regexp_replace(digits, '^\+', '');

  if digits like '254%' then
    digits := substring(digits from 4);
  elsif digits like '0%' then
    digits := substring(digits from 2);
  end if;

  if digits ~ '^[17][0-9]{8}$' then
    return '254' || digits;
  end if;

  return null; -- not a recognizable Kenyan mobile number - leave source value untouched
end;
$$;

-- Core login-lookup fields (landlords.phone / property_managers.phone /
-- tenants.primary_phone) - these three are what login, forgot-password,
-- and OTP resend actually query against.
update landlords
set phone = _rentapay_normalize_phone(phone)
where phone is not null and _rentapay_normalize_phone(phone) is not null and phone <> _rentapay_normalize_phone(phone);

update property_managers
set phone = _rentapay_normalize_phone(phone)
where phone is not null and _rentapay_normalize_phone(phone) is not null and phone <> _rentapay_normalize_phone(phone);

update tenants
set primary_phone = _rentapay_normalize_phone(primary_phone)
where primary_phone is not null and _rentapay_normalize_phone(primary_phone) is not null and primary_phone <> _rentapay_normalize_phone(primary_phone);

-- Secondary/contact phone fields aren't used for login, but normalizing
-- them too keeps WhatsApp-contact-resolution and reminder features
-- (which also expect 2547XXXXXXXX) working consistently for old data.
update tenants
set secondary_phone = _rentapay_normalize_phone(secondary_phone)
where secondary_phone is not null and _rentapay_normalize_phone(secondary_phone) is not null and secondary_phone <> _rentapay_normalize_phone(secondary_phone);

update tenants
set emergency_contact_phone = _rentapay_normalize_phone(emergency_contact_phone)
where emergency_contact_phone is not null and _rentapay_normalize_phone(emergency_contact_phone) is not null and emergency_contact_phone <> _rentapay_normalize_phone(emergency_contact_phone);

drop function _rentapay_normalize_phone(text);

-- VERIFICATION (run before/after to see what changed):
--   select id, phone from landlords where phone !~ '^254[17][0-9]{8}$' and phone is not null;
--   select id, phone from property_managers where phone !~ '^254[17][0-9]{8}$' and phone is not null;
--   select id, primary_phone from tenants where primary_phone !~ '^254[17][0-9]{8}$' and primary_phone is not null;
-- Any rows still returned above have a phone number that doesn't match
-- a recognizable Kenyan mobile shape at all (e.g. a landline, or a
-- typo) - those need a manual look, since the app can't safely guess
-- what they were meant to be.
-- =====================================================================
