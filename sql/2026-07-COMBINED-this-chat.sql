-- =====================================================================
-- COMBINED MIGRATION FILE - every SQL change made in this chat,
-- in the order they should be run. Each section is also saved as its
-- own standalone file if you'd rather run them one at a time:
--   1) 2026-07-tenant-rating-flag.sql
--   2) 2026-07-tenant-rating-rater-role.sql
--   3) 2026-07-normalize-existing-phone-numbers.sql
--   4) 2026-07-landlord-email-verification.sql
--
-- (The community-post "landlord_id foreign key" bug, the KES 50
-- signup-preview bug, the tap-to-reveal comment UI, the login-page
-- redesign, and removing phone-based login were all pure
-- application-code changes - no SQL was needed for any of them.)
-- =====================================================================


-- #######################################################################
-- 1) 2026-07-tenant-rating-flag.sql
--    Lets a TENANT flag a rating a landlord/manager/caretaker left about them as unfair, same recourse landlords already had.
-- #######################################################################

-- =====================================================================
-- DIRECT REQUEST: give a TENANT the same recourse against a bad-faith
-- rating that landlords already have (see add-rating-flag-for-review.sql)
-- - but on the other side of the relationship: a landlord/manager/
-- caretaker rating a tenant unfairly (e.g. retaliation after a
-- complaint, or right before a deposit dispute).
--
-- add-rating-flag-for-review.sql deliberately EXCLUDED tenant_ratings
-- from flagging, reasoning "those are written BY the landlord about a
-- tenant - the landlord doesn't need a flag path for their own
-- rating." That reasoning is correct for the LANDLORD side, but never
-- gave the TENANT (the one being rated) an equivalent path - this
-- fills that gap, symmetric to the landlord_ratings/staff_ratings/
-- property_ratings flow:
--   1. Tenant flags a rating left about them, with a reason -> the
--      rating is excluded from their portable-reputation aggregate
--      while the flag is pending, same as the landlord-side flow.
--   2. Admin reviews and resolves -> 'upheld' (goes back into the
--      aggregate) or 'removed' (stays excluded permanently).
--
-- Column shape mirrors the landlord-side columns exactly, just keyed
-- by flagged_by_tenant_id instead of flagged_by_landlord_id.
--
-- Note (attribution): unlike landlord_ratings/staff_ratings, a tenant
-- viewing their OWN tenant_ratings has always been allowed to see who
-- left each one (reputation.service.js already returns landlordName
-- per rating) - a tenant isn't at risk of "singling out" the one
-- landlord they currently have, so there was never an anonymity
-- requirement to preserve here the way there is for a landlord's pool
-- of many tenants.
-- =====================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'tenant_ratings' and column_name = 'flag_status') then
    alter table tenant_ratings add column flag_status text not null default 'none'
      check (flag_status in ('none', 'flagged', 'upheld', 'removed'));
    alter table tenant_ratings add column flagged_by_tenant_id uuid references tenants(id) on delete set null;
    alter table tenant_ratings add column flag_reason text;
    alter table tenant_ratings add column flagged_at timestamptz;
    alter table tenant_ratings add column flag_resolved_at timestamptz;
    alter table tenant_ratings add column flag_resolution_note text;
  end if;
end $$;

create index if not exists idx_tenant_ratings_flag_status on tenant_ratings(flag_status) where flag_status != 'none';

-- VERIFICATION:
--   select id, flag_status, flagged_by_tenant_id from tenant_ratings limit 1;
-- =====================================================================


-- #######################################################################
-- 2) 2026-07-tenant-rating-rater-role.sql
--    Tracks whether a tenant rating came from the landlord, a manager, or a caretaker, and lets caretakers rate tenants too.
-- #######################################################################

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


-- #######################################################################
-- 3) 2026-07-normalize-existing-phone-numbers.sql
--    One-time backfill so phone login works for accounts created before phone normalization was enforced.
-- #######################################################################

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


-- #######################################################################
-- 4) 2026-07-landlord-email-verification.sql
--    Adds email_verified + OTP columns for landlords (separate from is_verified, which stays payment-gated).
-- #######################################################################

-- =====================================================================
-- DIRECT REQUEST: landlords should get an OTP by email to verify that
-- email address during signup.
--
-- IMPORTANT - this is intentionally kept SEPARATE from `is_verified`.
-- A previous direct request (see the big comment on
-- activateLandlordAfterPayment() in auth.controller.js) explicitly
-- removed OTP as the thing that activates a landlord account:
-- "OTP should not have authority to confirm/verify the account - what
-- confirms it should be the payment." That's still correct and this
-- migration doesn't reopen it - is_verified stays payment-gated,
-- exactly as before.
--
-- What this adds is a NARROWER thing: proof the landlord typed their
-- real email correctly and can receive mail at it (catches typos,
-- fake addresses, etc.) - tracked in its own `email_verified` column
-- with its own OTP columns, so it can never become a second way to
-- flip account activation.
-- =====================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'landlords' and column_name = 'email_verified') then
    alter table landlords add column email_verified boolean not null default false;
    alter table landlords add column email_otp_code text;
    alter table landlords add column email_otp_expires_at timestamptz;
    alter table landlords add column email_otp_failed_attempts int not null default 0;
    alter table landlords add column email_otp_locked_until timestamptz;
  end if;
end $$;

-- Landlords who signed up before this feature existed shouldn't be
-- retroactively locked out of login over an email they were never
-- asked to verify - backfill them as already verified.
update landlords set email_verified = true where email_verified = false and is_verified = true;

-- VERIFICATION:
--   select id, email, email_verified from landlords order by created_at desc limit 5;
-- =====================================================================

