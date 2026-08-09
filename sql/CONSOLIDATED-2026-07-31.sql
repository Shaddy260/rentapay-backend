-- =====================================================================
-- CONSOLIDATED MIGRATION (auto-generated 2026-07-30)
--
-- Paste this ONE file and run it ONCE in the Supabase SQL Editor to
-- bring an EXISTING database fully up to date with the current
-- backend code, replacing the need to run all 80+ individual files
-- in sql/ by hand, and replacing the now-stale
-- COMBINED-run-this-once.sql (which only covered the first 12
-- migrations and was never updated after that).
--
-- WHAT THIS IS: a straight, in-order concatenation of every
-- migration file in sql/ (see the exact list and order at the
-- bottom of this header), EXCEPT:
--
--   - sql/schema.sql - the BASE schema. Do not include it here: it
--     uses plain "create table" (no "if not exists"), so it will
--     throw "relation already exists" and abort this whole script
--     if your database already has these tables - and it does, if
--     you're running this file at all. Only run schema.sql by
--     itself, and only on a brand new, empty database - then run
--     THIS file straight after to bring it fully current.
--
--   - sql/manual-account-activation.sql - a dev-only script that
--     needs YOUR real phone number and a hand-generated password
--     hash filled in first. Never run blindly as part of a batch.
--
-- WHAT THIS IS NOT: a semantically deduplicated, hand-reviewed
-- schema rewrite. It is a mechanical concatenation - most
-- individual files already guard their own statements with
-- "if not exists" / "add column if not exists" / "drop ... if
-- exists" (the project's existing convention - see
-- _check-what-is-applied.sql), which is what makes re-running them
-- in one pass safe. That guard was NOT independently re-verified
-- statement-by-statement for this file. Two migrations do fully
-- cancel out (add-scout-role.sql creates the 'scout' feature,
-- 2026-07-remove-scout-role.sql later removes it) - left in, in
-- order, rather than hand-pruned, so the end state matches exactly
-- what running every individual file in order would produce.
--
-- BEFORE RUNNING THIS ON A PRODUCTION DATABASE: run it against a
-- throwaway/staging copy first (e.g. a fresh Supabase branch or a
-- pg_dump'd copy) and confirm _check-what-is-applied.sql comes back
-- clean afterward.
--
-- ORDER (83 files, oldest to newest by file modification time -
-- the same signal the project's own filenames encode via their
-- date prefixes where present):
--   1. add-unit-freeze-columns.sql
--   2. add-tenant-security-deposit.sql
--   3. add-tenant-restore-history.sql
--   4. add-stk-phone-and-property-payment-fix.sql
--   5. add-scout-role.sql
--   6. add-scout-payments.sql
--   7. add-scout-password-reset-role.sql
--   8. add-scoped-deletes-and-help-categories.sql
--   9. add-platform-settings.sql
--   10. add-platform-message-targeting.sql
--   11. add-photo-url.sql
--   12. add-performance-indexes.sql
--   13. add-per-property-subscriptions.sql
--   14. add-pending-payment-confirmations.sql
--   15. add-payment-confirmation-resubmission.sql
--   16. add-paid-through-date.sql
--   17. add-otp-expiry-and-password-reset-log.sql
--   18. add-maintenance-requests.sql
--   19. add-landlord-manual-subscription-payments.sql
--   20. add-guest-help-requests.sql
--   21. add-gender-role-labels.sql
--   22. add-first-time-credentials.sql
--   23. add-expired-subscription-status.sql
--   24. add-expenses.sql
--   25. add-documents.sql
--   26. add-chat-messages.sql
--   27. add-caretaker-role-level.sql
--   28. add-billing-period.sql
--   29. 2026-07-web-push-subscriptions.sql
--   30. 2026-07-updates-v3.sql
--   31. 2026-07-updates-v2.sql
--   32. 2026-07-tenant-lists-and-whatsapp-group.sql
--   33. 2026-07-scout-exclusivity-and-constituency.sql
--   34. 2026-07-property-payments-caretaker.sql
--   35. 2026-07-property-payment-method.sql
--   36. 2026-07-property-managers.sql
--   37. 2026-07-notifications-inbox.sql
--   38. 2026-07-fixes.sql
--   39. 2026-07-chat-delete.sql
--   40. 2026-07-backfill-landlord-subscription-expiry.sql
--   41. 2026-07-announcements.sql
--   42. 2026-07-announcements-unit-scope.sql
--   43. add-scout-push-notifications.sql
--   44. add-scout-help-and-announcements.sql
--   45. 2026-07-manual-payment-duplicate-flagging.sql
--   46. add-scout-referrals.sql
--   47. 2026-07-admin-notifications-support.sql
--   48. 2026-07-performance-indexes.sql
--   49. 2026-07-notifications-property-scope.sql
--   50. 2026-07-notification-style-preference.sql
--   51. 2026-07-shorten-otp-expiry-windows.sql
--   52. add-scout-profile-photo.sql
--   53. add-otp-attempt-limiting.sql
--   54. add-unit-photos.sql
--   55. add-scout-referral-payouts.sql
--   56. add-onboarding-checklist.sql
--   57. 2026-07-community-board.sql
--   58. 2026-07-scout-lead-pipeline.sql
--   59. add-tenant-reputation.sql
--   60. add-landlord-reputation.sql
--   61. 2026-07-charge-disputes.sql
--   62. 2026-07-payment-plan-requests.sql
--   63. 2026-07-scout-leaderboard-index.sql
--   64. 2026-07-whatsapp-contact-numbers.sql
--   65. 2026-07-trim-existing-emails.sql
--   66. 2026-07-community-board-photos.sql
--   67. 2026-07-staff-ratings.sql
--   68. add-unit-public-listing-toggle.sql
--   69. 2026-07-remove-scout-role.sql
--   70. 2026-07-property-reputation-listing-status-deposit.sql
--   71. add-rating-flag-for-review.sql
--   72. 2026-07-tenant-rating-flag.sql
--   73. 2026-07-tenant-rating-rater-role.sql
--   74. 2026-07-normalize-existing-phone-numbers.sql
--   75. 2026-07-landlord-email-verification.sql
--   76. 2026-07-portfolio-digest.sql
--   77. 2026-07-community-reads.sql
--   78. add-unit-listing-description.sql
--   79. add-property-maps-link.sql
--   80. 2026-07-fix-missing-columns.sql
--   81. 2026-07-tenant-rating-reminders.sql
--   82. 2026-07-platform-reviews.sql
--   83. 2026-07-onboarding-loop-and-archive-reuse-fix.sql
-- =====================================================================


-- ============================================================
-- SECTION: add-unit-freeze-columns.sql
-- ============================================================
-- =====================================================================
-- ADD: units.is_frozen / units.frozen_at
--
-- Supports "when a landlord's unit count is reduced (self-downgrade on
-- renewal, or admin adjustment) and a removed unit had a tenant, that
-- tenant goes to Archive - not deleted - and the removed unit itself
-- is greyed out / frozen (no actions can be taken on it), but keeps
-- existing in the background so it can unlock automatically the
-- moment the landlord renews/upgrades back up to (or past) that unit
-- count again." See src/utils/unitLimitEnforcement.js for the logic
-- that sets/clears these.
-- =====================================================================

alter table units add column if not exists is_frozen boolean not null default false;
alter table units add column if not exists frozen_at timestamptz;

create index if not exists idx_units_landlord_frozen on units(landlord_id, is_frozen);


-- ============================================================
-- SECTION: add-tenant-security-deposit.sql
-- ============================================================
-- =====================================================================
-- Direct request: "when a landlord is entering the tenant details to
-- a unit they should record whether a tenant had paid deposit at
-- first entering of the house...that deposit should be read only to
-- the tenants and should not count as rent...should actually be a
-- security deposit refundable upon vacating depending on damages."
--
-- Deliberately separate from balance_due/payments - a deposit is not
-- rent and must never be added to or drawn from the rent ledger. It's
-- its own record: what was collected at move-in, and (later, at
-- move-out) what was returned vs withheld and why. RentaPay is not an
-- escrow service (see Terms) - this is pure record-keeping, the same
-- role it already plays for rent.
-- =====================================================================

alter table tenants add column if not exists deposit_amount numeric(12,2);
alter table tenants add column if not exists deposit_paid_at date;

-- 'held'      - collected at move-in, nothing settled yet (default
--               once a deposit_amount is recorded)
-- 'refunded'  - full amount returned at move-out
-- 'partially_refunded' - some withheld for damages/arrears, rest returned
-- 'forfeited' - none returned
alter table tenants add column if not exists deposit_status text
  check (deposit_status in ('held', 'refunded', 'partially_refunded', 'forfeited'));

alter table tenants add column if not exists deposit_refunded_amount numeric(12,2);
alter table tenants add column if not exists deposit_deduction_reason text;
alter table tenants add column if not exists deposit_settled_at timestamptz;
alter table tenants add column if not exists deposit_settled_by_type text; -- 'landlord' | 'manager'
alter table tenants add column if not exists deposit_settled_by_id uuid;


-- ============================================================
-- SECTION: add-tenant-restore-history.sql
-- ============================================================
-- =====================================================================
-- Direct request: archived/deleted tenants need a proper restore flow
-- - pick which unit to restore them into (not automatic), and an
-- explicit yes/no on whether their payment history comes with them
-- (never automated). Payment history was already tied to tenant_id
-- (not unit_id) via the existing payments.tenant_id foreign key, so
-- restoring to a different unit was never going to lose history by
-- itself - what was actually missing was (a) a real
-- archived-tenants list to restore FROM, and (b) a way to start a
-- restored tenant on a clean slate when the landlord explicitly
-- chooses not to bring the old history along, without deleting that
-- history outright (it stays on record).
-- =====================================================================

-- When a restore explicitly excludes history, payments dated before
-- this timestamp are hidden from the TENANT's own "my payment
-- history" view (a fresh start) but remain fully visible to the
-- landlord/manager's payment history + the archive record - nothing
-- is actually deleted by an "exclude history" restore.
alter table tenants add column if not exists history_visible_from timestamptz;


-- ============================================================
-- SECTION: add-stk-phone-and-property-payment-fix.sql
-- ============================================================
-- =====================================================================
-- Two direct requests:
--
-- 1. "The payment method between the landlord's apartments is
-- merging - it should be independent per apartment." The DB columns
-- for a per-property override (payment_override_enabled/method/
-- paybill_number/etc) already existed on `properties` (see
-- 2026-07-property-payment-method.sql) - but NO endpoint ever existed
-- to actually write to them. The Settings "Edit payment method" UI
-- was calling the landlord-wide endpoint regardless of which
-- apartment was selected, which is the actual reason every apartment
-- showed the same payment details - there was no per-property write
-- path at all, override columns or not. Fixed in
-- property.controller.js (new updatePropertyPaymentOverride
-- function) - this migration only adds the STK phone number columns
-- below, everything else needed already existed.
--
-- 2. "When a landlord sets payment method as STK push, they should
-- also add the number - shown below the words STK push."
-- =====================================================================

alter table landlords add column if not exists stk_phone_number text;
alter table properties add column if not exists payment_override_stk_phone_number text;


-- ============================================================
-- SECTION: add-scout-role.sql
-- ============================================================
-- =====================================================================
-- SCOUT ROLE — Phase 1 (schema only, no app code changes in this file)
--
-- Adds the fifth account type ("Scout") plus everything Phases 2-6
-- build on top of: per-county subscriptions (mirrors the existing
-- per-property subscription precedent in add-per-property-subscriptions.sql
-- — never a flat account-level status, since one county can expire
-- independently of another), tiered county pricing, landlord block/
-- opt-out controls, and a `scout_landlord` chat thread type.
--
-- Do NOT proceed to Phase 2 app code until every statement below has
-- actually been run AND verified (tables visible in Table Editor,
-- constraints present in pg_constraint) — a green checkmark on the
-- query alone is not verification, same lesson as every other
-- COMBINED-run-this-once.sql migration in this repo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Scout accounts
-- ---------------------------------------------------------------------
create table if not exists scouts (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  password_hash text not null,
  full_name text not null,
  email text,
  otp_code text,
  otp_expires_at timestamptz,
  is_verified boolean not null default false, -- mirrors landlords/tenants: set true by verifyOTP after signup
  is_active boolean not null default true,     -- admin-level suspend switch, same meaning as property_managers.is_active
  must_change_password boolean not null default false,
  failed_login_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_scouts_phone on scouts(phone);

-- ---------------------------------------------------------------------
-- Per-county subscriptions — one row per (scout, county), each with its
-- own expiry. A Scout might add Nairobi in January and Kiambu in June;
-- they must not share a renewal date.
-- ---------------------------------------------------------------------
create table if not exists scout_county_subscriptions (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid not null references scouts(id) on delete cascade,
  county text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null check (status in ('active', 'expired')),
  unique (scout_id, county)
);

create index if not exists idx_scout_county_subs_scout on scout_county_subscriptions(scout_id);
create index if not exists idx_scout_county_subs_expiry on scout_county_subscriptions(county, expires_at);

-- ---------------------------------------------------------------------
-- County pricing tiers — a lookup table, not hardcoded, so prices can
-- be retuned later without a schema change.
-- ---------------------------------------------------------------------
create table if not exists county_pricing_tiers (
  county text primary key,
  tier smallint not null,
  annual_price numeric(10,2) not null
);

insert into county_pricing_tiers (county, tier, annual_price) values
  ('Nairobi', 1, 4000), ('Mombasa', 1, 4000), ('Kiambu', 1, 4000), ('Nakuru', 1, 4000),
  ('Kisumu', 2, 2500), ('Uasin Gishu', 2, 2500), ('Machakos', 2, 2500), ('Kajiado', 2, 2500)
on conflict (county) do nothing;
-- Every other Kenyan county: insert at tier 3, annual_price 1200.
-- FOLLOW-UP (not yet run — do this once the full 47-county list is
-- finalized against constants/kenyaCounties.js, so the lookup table and
-- the frontend's county dropdown never disagree on what counties exist):
--
--   insert into county_pricing_tiers (county, tier, annual_price)
--   select county_name, 3, 1200
--   from unnest(array[...all 47 counties from kenyaCounties.js...]) as county_name
--   on conflict (county) do nothing;

-- ---------------------------------------------------------------------
-- Landlord can block a specific scout from all their properties
-- ---------------------------------------------------------------------
create table if not exists blocked_scouts (
  landlord_id uuid not null references landlords(id) on delete cascade,
  scout_id uuid not null references scouts(id) on delete cascade,
  blocked_at timestamptz not null default now(),
  primary key (landlord_id, scout_id)
);

-- ---------------------------------------------------------------------
-- Per-landlord opt-out of Scout visibility, plus tracking whether
-- they've seen the one-time disclosure (Phase 5f).
-- ---------------------------------------------------------------------
alter table landlords add column if not exists scout_visibility_enabled boolean not null default true;
alter table landlords add column if not exists scout_disclosure_seen_at timestamptz;

-- ---------------------------------------------------------------------
-- Chat extension for masked scout<->landlord contact (Phase 5e)
--
-- IMPORTANT: chat_messages has already been migrated once since it was
-- first created (see 2026-07-chat-delete.sql), which DROPPED and
-- RE-ADDED the sender_role check under a new explicit name
-- (chat_messages_sender_role_check) and widened it to include
-- 'manager', and added a *separate* named shape constraint
-- (chat_messages_thread_shape) distinct from the inline, auto-named
-- thread_type check (chat_messages_thread_type_check). This migration
-- updates all three, plus the newer chat_message_hidden.viewer_role
-- check and deleted_by_role check added in that same file — not just
-- the ones the original add-chat-messages.sql defined. Confirm these
-- constraint names still match pg_constraint in your instance before
-- running (`select conname from pg_constraint where conrelid =
-- 'chat_messages'::regclass;`) in case anything has moved again since.
-- ---------------------------------------------------------------------

alter table chat_messages add column if not exists scout_id uuid references scouts(id) on delete cascade;
alter table chat_messages add column if not exists read_by_scout boolean not null default false;

-- thread_type: widen the inline check to add 'scout_landlord'
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_thread_type_check') then
    alter table chat_messages drop constraint chat_messages_thread_type_check;
  end if;
end $$;

alter table chat_messages
  add constraint chat_messages_thread_type_check
  check (thread_type in ('admin_landlord', 'admin_tenant', 'landlord_tenant', 'scout_landlord'));

-- shape: widen the named shape constraint to add the scout_landlord case
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_thread_shape') then
    alter table chat_messages drop constraint chat_messages_thread_shape;
  end if;
end $$;

alter table chat_messages
  add constraint chat_messages_thread_shape check (
    (thread_type = 'admin_landlord'  and landlord_id is not null and tenant_id is null and scout_id is null) or
    (thread_type = 'admin_tenant'    and tenant_id is not null) or
    (thread_type = 'landlord_tenant' and landlord_id is not null and tenant_id is not null and scout_id is null) or
    (thread_type = 'scout_landlord'  and scout_id is not null and landlord_id is not null and tenant_id is null)
  );

-- sender_role: widen to add 'scout' alongside the existing 'manager' widening
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_sender_role_check') then
    alter table chat_messages drop constraint chat_messages_sender_role_check;
  end if;
end $$;

alter table chat_messages
  add constraint chat_messages_sender_role_check
  check (sender_role in ('admin', 'landlord', 'manager', 'tenant', 'scout'));

-- deleted_by_role: same widening, so a scout deleting their own message
-- (delete-for-everyone) doesn't hit a check-constraint 500 later
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_deleted_by_role_check') then
    alter table chat_messages drop constraint chat_messages_deleted_by_role_check;
  end if;
end $$;

alter table chat_messages
  add constraint chat_messages_deleted_by_role_check
  check (deleted_by_role in ('admin', 'landlord', 'manager', 'tenant', 'scout'));

-- chat_message_hidden.viewer_role: same widening, for delete-for-me
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_message_hidden_viewer_role_check') then
    alter table chat_message_hidden drop constraint chat_message_hidden_viewer_role_check;
  end if;
end $$;

alter table chat_message_hidden
  add constraint chat_message_hidden_viewer_role_check
  check (viewer_role in ('admin', 'landlord', 'manager', 'tenant', 'scout'));

create index if not exists idx_chat_scout_landlord on chat_messages(thread_type, scout_id, landlord_id) where thread_type = 'scout_landlord';

-- =====================================================================
-- VERIFICATION — run these after the above and eyeball the output
-- before touching any app code:
--
--   select table_name from information_schema.tables
--     where table_name in ('scouts','scout_county_subscriptions','county_pricing_tiers','blocked_scouts');
--
--   select column_name from information_schema.columns
--     where table_name = 'landlords' and column_name in ('scout_visibility_enabled','scout_disclosure_seen_at');
--
--   select column_name from information_schema.columns
--     where table_name = 'chat_messages' and column_name in ('scout_id','read_by_scout');
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'chat_messages'::regclass and contype = 'c';
-- =====================================================================


-- ============================================================
-- SECTION: add-scout-payments.sql
-- ============================================================
-- =====================================================================
-- SCOUT ROLE — Phase 4 schema addendum (registration + payment)
--
-- Run this AFTER add-scout-role.sql. Adds the two payment tables the
-- STK/manual flows need (mirrors subscription_payments and
-- landlord_manual_subscription_payments respectively), and fills in
-- the tier-3 county pricing rows that Phase 1 deliberately deferred
-- until the full 47-county list could be cross-checked against
-- constants/kenyaCounties.js (done below - all 39 counties not
-- already listed at tier 1/2).
-- =====================================================================

-- ---------------------------------------------------------------------
-- STK push payments for county subscriptions. One row can cover
-- MULTIPLE counties bought in the same checkout (counties is a jsonb
-- array) - the callback fans that out into one
-- scout_county_subscriptions upsert per county.
-- ---------------------------------------------------------------------
create table if not exists scout_county_payments (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid not null references scouts(id) on delete cascade,

  counties jsonb not null, -- e.g. ["Nairobi","Kiambu"]
  amount numeric(12,2) not null,

  mpesa_transaction_id text,
  mpesa_phone text,
  mpesa_checkout_request_id text,

  status text check (status in ('pending', 'completed', 'failed')) default 'pending',

  paid_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_scout_county_payments_scout on scout_county_payments(scout_id);
create index if not exists idx_scout_county_payments_checkout on scout_county_payments(mpesa_checkout_request_id);

-- ---------------------------------------------------------------------
-- Manual Paybill fallback, same shape/review flow as
-- landlord_manual_subscription_payments - a Scout submits proof of a
-- payment made directly to RentaPay's platform paybill, an admin
-- confirms or rejects it.
-- ---------------------------------------------------------------------
create table if not exists scout_manual_county_payments (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid not null references scouts(id) on delete cascade,

  counties jsonb not null,
  amount_paid numeric(12,2) not null,

  transaction_code text not null,
  mpesa_payer_name text not null,
  mpesa_payer_phone text not null,
  mpesa_sms_timestamp text,

  status text not null default 'pending', -- pending | confirmed | rejected
  actioned_by_admin_id uuid,
  rejection_reason text,
  confirmed_or_rejected_at timestamptz,

  submitted_at timestamptz not null default now()
);

create index if not exists idx_scout_manual_county_payments_scout on scout_manual_county_payments(scout_id);
create index if not exists idx_scout_manual_county_payments_status on scout_manual_county_payments(status);

-- ---------------------------------------------------------------------
-- Tier-3 pricing for every county not already seeded at tier 1/2 in
-- add-scout-role.sql. Cross-checked against the 47-county list in
-- constants/kenyaCounties.js so the pricing table and the frontend's
-- county dropdown can never disagree on what counties exist.
-- ---------------------------------------------------------------------
insert into county_pricing_tiers (county, tier, annual_price) values
  ('Kwale', 3, 1200), ('Kilifi', 3, 1200), ('Tana River', 3, 1200), ('Lamu', 3, 1200),
  ('Taita-Taveta', 3, 1200), ('Garissa', 3, 1200), ('Wajir', 3, 1200), ('Mandera', 3, 1200),
  ('Marsabit', 3, 1200), ('Isiolo', 3, 1200), ('Meru', 3, 1200), ('Tharaka-Nithi', 3, 1200),
  ('Embu', 3, 1200), ('Kitui', 3, 1200), ('Makueni', 3, 1200), ('Nyandarua', 3, 1200),
  ('Nyeri', 3, 1200), ('Kirinyaga', 3, 1200), ('Murang''a', 3, 1200), ('Turkana', 3, 1200),
  ('West Pokot', 3, 1200), ('Samburu', 3, 1200), ('Trans Nzoia', 3, 1200), ('Elgeyo-Marakwet', 3, 1200),
  ('Nandi', 3, 1200), ('Baringo', 3, 1200), ('Laikipia', 3, 1200), ('Narok', 3, 1200),
  ('Kericho', 3, 1200), ('Bomet', 3, 1200), ('Kakamega', 3, 1200), ('Vihiga', 3, 1200),
  ('Bungoma', 3, 1200), ('Busia', 3, 1200), ('Siaya', 3, 1200), ('Homa Bay', 3, 1200),
  ('Migori', 3, 1200), ('Kisii', 3, 1200), ('Nyamira', 3, 1200)
on conflict (county) do nothing;

-- VERIFICATION:
--   select count(*) from county_pricing_tiers; -- should be 47
--   select table_name from information_schema.tables
--     where table_name in ('scout_county_payments','scout_manual_county_payments');


-- ============================================================
-- SECTION: add-scout-password-reset-role.sql
-- ============================================================
-- =====================================================================
-- Fix: scout password-reset requests were silently failing to log to
-- the admin portal.
--
-- requestPasswordReset() in auth.controller.js has generically
-- supported accountType 'scout' since Phase 4/5 - a scout's OTP is
-- generated and sent correctly. But the write to
-- password_reset_requests (the table the admin portal reads to show
-- "recover this OTP if the SMS never arrived") was wrapped in a
-- try/catch that swallows errors as non-fatal - so every single scout
-- password-reset request has been hitting this table's
-- check (role in ('landlord','tenant','manager','caretaker')),
-- failing the constraint, being logged as a warning server-side, and
-- never showing up anywhere in the admin portal. The scout still gets
-- their SMS, so nothing was broken for the scout themself - only the
-- admin's ability to recover/resend if that SMS never arrived.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql and
-- add-otp-expiry-and-password-reset-log.sql.
-- =====================================================================

alter table password_reset_requests drop constraint if exists password_reset_requests_role_check;

alter table password_reset_requests
  add constraint password_reset_requests_role_check
  check (role in ('landlord', 'tenant', 'manager', 'caretaker', 'scout'));


-- ============================================================
-- SECTION: add-scoped-deletes-and-help-categories.sql
-- ============================================================
-- FIX (direct request): "when a landlord or caretaker or manager
-- confirms/rejects a payment, deleting it should only remove it from
-- their own view - it should not delete it out from under the other
-- two roles." pending_payment_confirmations previously had a single
-- shared row hard-deleted by DELETE /pending-confirmations/:id, so a
-- landlord deleting a confirmed record also erased it for every
-- manager/caretaker looking at the exact same landlord's list (and
-- vice versa). This adds one "hidden for this viewer type" flag per
-- viewer type instead of a real delete; the row is only ever
-- physically removed once every viewer type that can see it has
-- hidden it.
alter table pending_payment_confirmations
  add column if not exists hidden_for_landlord boolean not null default false,
  add column if not exists hidden_for_manager boolean not null default false,
  add column if not exists hidden_for_caretaker boolean not null default false;

-- FIX (direct request): help requests should be categorized by who
-- sent them (landlord / tenant / manager / caretaker / guest), not
-- just lumped together. requester_type already distinguishes
-- landlord/tenant/guest, but a property manager and a caretaker both
-- come through as backend role 'manager' - this captures the
-- sub-level so the admin portal can split them into their own tab.
alter table help_requests
  add column if not exists requester_role_level text;

-- FIX (direct request): "it should show also the phone number used to
-- send money - that should be entered by the tenants during
-- submission." Only the payer's NAME was ever captured, never the
-- phone the payment was actually sent from - which matters for
-- cross-checking against the real M-Pesa SMS when confirming.
alter table pending_payment_confirmations
  add column if not exists mpesa_payer_phone text;


-- ============================================================
-- SECTION: add-platform-settings.sql
-- ============================================================
-- =====================================================================
-- Migration: add platform_settings table
-- =====================================================================
-- Run once in Supabase SQL Editor. Makes emergency lockdown actually
-- block logins platform-wide (landlords, tenants, and previously it
-- did neither correctly) instead of only flipping a field login()
-- never checked.

create table if not exists platform_settings (
  id int primary key default 1,
  is_locked_down boolean default false,
  lockdown_reason text,
  lockdown_started_at timestamptz,
  constraint single_row check (id = 1)
);

insert into platform_settings (id, is_locked_down)
values (1, false)
on conflict (id) do nothing;


-- ============================================================
-- SECTION: add-platform-message-targeting.sql
-- ============================================================
-- Direct request: "in the admin portal under messages, there should
-- be options as to whom to send the message to - all, tenants only,
-- or landlords/managers/caretakers only (as these three share a
-- common dashboard)." Platform-wide announcements previously always
-- reached literally everyone with no way to narrow it.
alter table announcements add column if not exists platform_target_group text
  check (platform_target_group in ('all', 'tenants', 'landlord_team'));
-- Existing rows (sent before this column existed) default to 'all' in
-- application code when this is null, so nothing already sent
-- suddenly stops reaching people it used to reach.


-- ============================================================
-- SECTION: add-photo-url.sql
-- ============================================================
-- =====================================================================
-- Migration: add photo_url to landlords and tenants
-- =====================================================================
-- Run once in Supabase SQL Editor. Stores a URL to a profile picture,
-- not the binary file itself - actual file upload/hosting (e.g. via
-- Supabase Storage) is a separate piece of work, scoped for later in
-- the same session this migration was requested in.

alter table landlords add column if not exists photo_url text;
alter table tenants add column if not exists photo_url text;


-- ============================================================
-- SECTION: add-performance-indexes.sql
-- ============================================================
-- =====================================================================
-- Direct request: "twice as fast, ultra navigation." Compression and
-- parallel queries (see server.js / dashboard.controller.js) cut down
-- on network time and round-trip count; this cuts down on how long
-- the database itself takes to answer the queries those round-trips
-- are making. Every index below matches a WHERE/IN clause that's hit
-- on nearly every dashboard, unit-detail, or tenant-portal load -
-- without it, Postgres has to scan every row in the table instead of
-- jumping straight to the ones that match.
-- =====================================================================

-- payments.unit_id is filtered on the unit detail page and the
-- dashboard's "this month's payments" query - had no index at all
-- before this (only tenant_id and landlord_id did).
create index if not exists idx_payments_unit on payments(unit_id);

-- Every dashboard/tenant-list load filters tenants by landlord_id AND
-- is_active together (active tenants only) - a composite index here
-- serves that combination directly instead of matching landlord_id
-- broadly and then scanning for is_active within that set.
create index if not exists idx_tenants_landlord_active on tenants(landlord_id, is_active);

-- The property switcher and per-apartment subscription lookups filter
-- by landlord_id then sort/check status - same reasoning.
create index if not exists idx_properties_landlord_status on properties(landlord_id, subscription_status);

-- Payment-date-range queries (this month's payments, payment history)
-- filter status='completed' then a paid_at range - composite index
-- covers both in one lookup instead of two.
create index if not exists idx_payments_status_paid_at on payments(status, paid_at);

-- First-time credentials and archived-tenant lookups both filter by
-- landlord_id then sort by created_at/left_at - keeps those lists
-- fast as they grow.
create index if not exists idx_first_time_credentials_created on first_time_credentials(landlord_id, created_at desc);
create index if not exists idx_tenants_landlord_left_at on tenants(landlord_id, left_at desc) where is_active = false;

-- New hot path: per-property unit-limit reconciliation and the
-- "Add Unit" capacity check (see unitLimitEnforcement.js /
-- unit.controller.js) both filter units by property_id AND is_frozen
-- together for properties on their own independent subscription
-- clock. idx_units_landlord_frozen already covers the landlord-wide
-- (pooled) case; this covers the per-property case the same way.
create index if not exists idx_units_property_frozen on units(property_id, is_frozen);


-- ============================================================
-- SECTION: add-per-property-subscriptions.sql
-- ============================================================
-- =====================================================================
-- Direct request: "if a landlord has added other apartments, each
-- apartment he shifts to should show their own subscription period...
-- if one expires and he logs in he should subscribe to it
-- differently... every apartment should specifically show the number
-- of units he paid for - under no circumstance should they show the
-- same number."
--
-- Before this, EVERY property a landlord owns shared one pooled
-- unit_limit and one shared subscription_expires_at on the landlords
-- row - buying a second property just added its units count onto the
-- same landlord-wide total and rode the same expiry clock as
-- everything else. That's structurally why apartments could never
-- show different numbers.
--
-- Scope of this change: the landlord's ORIGINAL/first property (set
-- up during initial registration, before any property even exists as
-- its own row) keeps using the landlords-row fields exactly as before
-- - nothing about day-one signup changes. Every property bought
-- afterwards via property_payments (the "add another apartment" flow)
-- now gets its OWN subscription_expires_at/period/unit_limit/status,
-- independent of every other property on the account.
-- =====================================================================

alter table properties add column if not exists unit_limit int;
alter table properties add column if not exists subscription_period_months int;
alter table properties add column if not exists subscription_started_at timestamptz;
alter table properties add column if not exists subscription_expires_at timestamptz;
alter table properties add column if not exists subscription_status text
  check (subscription_status in ('active', 'expired')) default 'active';

-- Existing properties (created before this migration) were riding on
-- the landlord's pooled clock - backfill them from their landlord's
-- current values so nothing suddenly looks unpaid/expired the moment
-- this migration runs. New properties purchased from here on get
-- their own real value written in completePropertyPurchase instead of
-- this fallback.
update properties p
set
  unit_limit = coalesce(p.unit_limit, (select l.unit_limit from landlords l where l.id = p.landlord_id)),
  subscription_period_months = coalesce(p.subscription_period_months, (select l.subscription_period_months from landlords l where l.id = p.landlord_id)),
  subscription_started_at = coalesce(p.subscription_started_at, (select l.subscription_started_at from landlords l where l.id = p.landlord_id)),
  subscription_expires_at = coalesce(p.subscription_expires_at, (select l.subscription_expires_at from landlords l where l.id = p.landlord_id)),
  subscription_status = case when (select l.subscription_status from landlords l where l.id = p.landlord_id) = 'active' then 'active' else 'expired' end
where p.unit_limit is null;

-- Track which property a given property_payments / subscription_payments
-- row is for, so the Daraja callback knows which property's clock to
-- update rather than always touching the landlord's pooled fields.
alter table property_payments add column if not exists renews_property_id uuid references properties(id);

-- Direct request: "don't fix the subscription period, let the
-- landlord enter their own subscription time they wish" - this is the
-- landlord's freely-chosen number of months for THIS purchase
-- (new property, or later a renewal of an existing one), instead of
-- inferring it from whatever happened to be left on a shared clock.
alter table property_payments add column if not exists period_months int default 1;


-- ============================================================
-- SECTION: add-pending-payment-confirmations.sql
-- ============================================================
-- =====================================================================
-- ADD: pending_payment_confirmations
-- Manual Paybill payment confirmation flow - tenants pay rent by
-- sending money directly to their landlord's own Till/Paybill/Phone
-- (NOT via Daraja/STK push), then submit proof here for the landlord
-- or property manager to manually confirm or reject. Run this once,
-- manually, in the Supabase SQL editor - same convention as every
-- other file in sql/ (never edit schema.sql directly).
-- =====================================================================

create table if not exists pending_payment_confirmations (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null references tenants(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid references properties(id) on delete set null, -- optional, multi-property support

  transaction_code text not null,      -- normalized uppercase/trimmed M-Pesa code
  amount_paid numeric(12,2) not null,
  mpesa_payer_name text not null,
  mpesa_sms_timestamp timestamptz,     -- optional - the time shown on the tenant's M-Pesa SMS, NOT auto-generated

  submitted_at timestamptz not null default now(), -- auto-captured, not editable by tenant

  status text check (status in ('pending', 'confirmed', 'rejected')) not null default 'pending',

  -- Which user account actioned it - split into two FK columns since a
  -- landlord and a property manager live in two different tables and
  -- Postgres FKs can only reference one. Exactly one of these is set
  -- per row (whichever role actually confirmed/rejected); the other
  -- stays null. "on delete set null" so a deleted landlord/manager
  -- account doesn't take the historical record down with it - the
  -- receipt/confirmation record should still say who did it even
  -- after that account is gone (we also snapshot their name into
  -- payments.recorded_note at confirm time for the same reason).
  confirmed_or_rejected_by_landlord uuid references landlords(id) on delete set null,
  confirmed_or_rejected_by_manager uuid references property_managers(id) on delete set null,
  confirmed_or_rejected_at timestamptz,
  rejection_reason text,

  -- Fraud flag: set when transaction_code matched an existing
  -- CONFIRMED record at submission time. The record is still created
  -- (not silently rejected) - a human decides.
  duplicate_of uuid references pending_payment_confirmations(id) on delete set null,

  created_at timestamptz not null default now(),

  constraint chk_single_confirmer check (
    confirmed_or_rejected_by_landlord is null or confirmed_or_rejected_by_manager is null
  )
);

-- Fast duplicate lookups on submit
create index if not exists idx_pending_payment_confirmations_txn_code
  on pending_payment_confirmations(transaction_code);

-- Fast pending-list query, scoped per landlord
create index if not exists idx_pending_payment_confirmations_landlord_status
  on pending_payment_confirmations(landlord_id, status);


-- ============================================================
-- SECTION: add-payment-confirmation-resubmission.sql
-- ============================================================
-- =====================================================================
-- ADD: pending_payment_confirmations.resubmission_of
--
-- "When a tenant re-submits after a rejection, it should land in the
-- landlord's portal as a priority with a label - Resubmitted Request -
-- and appear at the top of all other requests regardless of when it
-- was sent." This links a new submission back to the rejected one it
-- replaces, so the UI can flag and prioritize it.
-- =====================================================================

alter table pending_payment_confirmations
  add column if not exists resubmission_of uuid references pending_payment_confirmations(id) on delete set null;

create index if not exists idx_pending_payment_confirmations_resubmission
  on pending_payment_confirmations(resubmission_of);


-- ============================================================
-- SECTION: add-paid-through-date.sql
-- ============================================================
-- =====================================================================
-- Migration: add paid_through_date to tenants
-- =====================================================================
-- Run this once in Supabase SQL Editor against your existing database.
-- Safe to run even if you already have tenant rows - the column
-- defaults to NULL for everyone (meaning "not tracked / no prepayment
-- yet"), nothing existing breaks.

alter table tenants
  add column if not exists paid_through_date date;

-- Optional: backfill an initial value for existing active tenants
-- based on their current due date, so the feature has a sane starting
-- point rather than NULL for tenants who already existed before this
-- migration. Adjust or skip this if you'd rather start everyone fresh.
--
-- update tenants t
-- set paid_through_date = (
--   select (date_trunc('month', current_date) +
--           (coalesce(t.due_day_of_month, u.due_day_of_month) - 1) * interval '1 day')::date
--   from units u where u.id = t.unit_id
-- )
-- where t.is_active = true and t.paid_through_date is null;


-- ============================================================
-- SECTION: add-otp-expiry-and-password-reset-log.sql
-- ============================================================
-- =====================================================================
-- Direct request (follow-up to add-first-time-credentials.sql):
-- "landlords receive OTPs too, for password resets - those should be
-- stored to the admin portal same as first-time credentials, arranged
-- by category. ALL of these (first_time_credentials, this new table,
-- AND the real otp_code columns on the account tables) should expire
-- and be DELETED the moment their expiry time is reached - not just
-- treated as invalid."
--
-- Two changes:
--
-- 1) first_time_credentials gets an expires_at column. It never had
--    an expiry concept before (blueprint 13.x treated it as valid
--    until the person's first login), but it's added here at a
--    generous 14 days so old temp-password rows don't pile up
--    forever - by day 14 the person has either logged in already
--    (which forces a real password via must_change_password) or the
--    account was a dead end anyway.
--
-- 2) password_reset_requests: a NEW table, deliberately separate from
--    first_time_credentials rather than folding into it - the two
--    represent different moments (account creation vs. an existing
--    account being recovered) and first_time_credentials.role's check
--    constraint intentionally excludes 'landlord' since landlords
--    never got a first-time temp password. Landlords DO request
--    password resets like anyone else, so this table's role list
--    includes 'landlord' where the other table's does not.
-- =====================================================================

alter table first_time_credentials
  add column if not exists expires_at timestamptz not null default (now() + interval '14 days');

create table if not exists password_reset_requests (
  id uuid primary key default gen_random_uuid(),
  -- null for a landlord's own reset request (there's no "owning"
  -- landlord above a landlord) - populated for tenant/manager/caretaker
  -- so the landlord portal can filter to just their own people.
  landlord_id uuid references landlords(id) on delete cascade,
  role text not null check (role in ('landlord', 'tenant', 'manager', 'caretaker')),
  account_id uuid not null, -- the landlords.id / tenants.id / property_managers.id row
  full_name text not null,
  phone text not null,
  otp text not null,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_password_reset_requests_landlord on password_reset_requests(landlord_id, role);
create index if not exists idx_password_reset_requests_expiry on password_reset_requests(expires_at);
create index if not exists idx_first_time_credentials_expiry on first_time_credentials(expires_at);


-- ============================================================
-- SECTION: add-maintenance-requests.sql
-- ============================================================
-- =====================================================================
-- Direct request: "maintenance/repair ticketing." Deliberately a
-- separate table from help_requests - help_requests is wired to
-- RentaPay's own admin support inbox (see help.controller.js, which
-- emails SUPER_ADMIN_EMAIL), which is the wrong destination for "my
-- tap is leaking" - that needs to reach the actual landlord/caretaker
-- who manages the property, not RentaPay's support team. The existing
-- "Complaints" panel in both portals currently reuses help_requests
-- for exactly this, which means tenant maintenance issues have been
-- landing only in RentaPay's own inbox, invisible to the landlord.
-- This table is what the landlord/caretaker actually needs to see.
-- =====================================================================

create table if not exists maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  property_id uuid references properties(id) on delete set null,
  landlord_id uuid not null references landlords(id) on delete cascade,
  title text not null,
  description text,
  photo_url text,
  -- 'open'         - just submitted, nobody has picked it up
  -- 'in_progress'  - a caretaker/landlord/manager is on it
  -- 'resolved'     - fixed
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_type text, -- 'landlord' | 'manager'
  resolved_by_id uuid
);

create index if not exists idx_maintenance_requests_tenant on maintenance_requests(tenant_id);
create index if not exists idx_maintenance_requests_landlord_status on maintenance_requests(landlord_id, status);
create index if not exists idx_maintenance_requests_property on maintenance_requests(property_id);


-- ============================================================
-- SECTION: add-landlord-manual-subscription-payments.sql
-- ============================================================
-- =====================================================================
-- Direct request: landlord subscription payments need a manual
-- fallback ("sometimes the popup is not sent, so there should be a
-- ui underneath that says didn't receive the popup...pay manually")
-- that lands in a NEW admin-only queue ("landlords manual payment
-- confirmations") with Confirm / Reject / Delete, separate from the
-- existing tenant-facing pending_payment_confirmations table (that
-- one is scoped to tenant_id/unit_id, which a landlord paying their
-- OWN platform subscription doesn't have).
--
-- Whoever submits this can be the landlord, a manager, or a
-- caretaker on that account (direct request: "whatever happens in
-- landlord subscription, the managers and caretakers account should
-- be the same too since they see same as landlords") - submitted_by_*
-- records exactly who, landlord_id is always the account this
-- payment is meant to renew/activate.
-- =====================================================================

create table if not exists landlord_manual_subscription_payments (
  id uuid primary key default gen_random_uuid(),

  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid references properties(id) on delete set null, -- set when this is renewing/activating one specific apartment's own clock, null when it's the account-wide (original property) subscription

  submitted_by_role text not null check (submitted_by_role in ('landlord', 'manager', 'caretaker')),
  submitted_by_landlord_id uuid references landlords(id) on delete set null,
  submitted_by_manager_id uuid references property_managers(id) on delete set null,

  transaction_code text not null,
  amount_paid numeric(12,2) not null,
  mpesa_payer_name text not null,
  mpesa_payer_phone text not null,
  mpesa_sms_timestamp timestamptz,

  period_months int not null default 1,
  units_count int not null,

  submitted_at timestamptz not null default now(),

  status text check (status in ('pending', 'confirmed', 'rejected')) not null default 'pending',

  actioned_by_admin_id uuid,
  confirmed_or_rejected_at timestamptz,
  rejection_reason text,

  created_at timestamptz not null default now()
);

create index if not exists idx_landlord_manual_sub_payments_status on landlord_manual_subscription_payments(status, submitted_at desc);
create index if not exists idx_landlord_manual_sub_payments_landlord on landlord_manual_subscription_payments(landlord_id);


-- ============================================================
-- SECTION: add-guest-help-requests.sql
-- ============================================================
-- Migration: allow pre-login ("guest") help requests
-- Run this if your database was created before this change.
-- Lets the Login page's Help button submit a request before the
-- person has an account/token (blueprint 15: "help before logging in").

alter table help_requests drop constraint if exists help_requests_requester_type_check;
alter table help_requests add constraint help_requests_requester_type_check
  check (requester_type in ('landlord', 'tenant', 'guest'));

alter table help_requests alter column requester_id drop not null;


-- ============================================================
-- SECTION: add-gender-role-labels.sql
-- ============================================================
-- =====================================================================
-- Adds "gender" to landlords and property_managers (direct request:
-- "some landlords are landladies - avoid biasness, ask their gender
-- at setup and display the correct wording"). Nullable, not required
-- retroactively - existing accounts fall back to the neutral label
-- ("Landlord" / "Manager"/"Caretaker") until they set it once in
-- Settings. Tenants aren't included: blueprint never referred to a
-- tenant's role by a gendered noun, so there's nothing to disambiguate
-- there.
-- =====================================================================

alter table landlords add column if not exists gender text
  check (gender in ('male', 'female'));

alter table property_managers add column if not exists gender text
  check (gender in ('male', 'female'));


-- ============================================================
-- SECTION: add-first-time-credentials.sql
-- ============================================================
-- =====================================================================
-- Direct request: "when a landlord or manager is adding a tenant, the
-- details might not be sent - so there should be a table in menu that
-- stores those first-time accounts... stores the unit number, the
-- tenant details and the otp and temp password... during creation of
-- accts only. Should also store for caretakers in both managers and
-- landlords portal - but the landlord's portal should store for
-- manager, caretaker and tenants, in different tables based on role."
--
-- Implemented as one table with a `role` column rather than three
-- literal separate SQL tables - the landlord's menu simply shows three
-- separate filtered views (Tenants / Managers / Caretakers) over the
-- same underlying record, which gets the same result (three distinct
-- lists) without three copies of the same schema to keep in sync.
--
-- Note the real tradeoff being made here: this stores the temp
-- password in PLAIN TEXT (not hashed), which is unusual and normally
-- avoided - but the whole point of this table is to be human-readable
-- so it can be manually handed to someone whose SMS never arrived.
-- The exposure window is bounded by must_change_password already
-- forcing a real password on first login, same as it always has.
-- =====================================================================

create table if not exists first_time_credentials (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  role text not null check (role in ('tenant', 'manager', 'caretaker')),
  account_id uuid not null, -- the tenants.id or property_managers.id row this belongs to
  full_name text not null,
  phone text not null,
  unit_name text, -- tenants only; null for manager/caretaker rows
  property_name text, -- which apartment this tenant/caretaker belongs to, for context
  temp_password text not null,
  otp text not null,
  created_by_role text not null, -- 'landlord' or 'manager' - who actually created this account
  created_at timestamptz not null default now()
);

create index if not exists idx_first_time_credentials_landlord on first_time_credentials(landlord_id, role);


-- ============================================================
-- SECTION: add-expired-subscription-status.sql
-- ============================================================
-- =====================================================================
-- FIX ("subscription expired shouldn't say 'account suspended'"):
-- the subscription-expiry cron job (subscriptionReminders.job.js) was
-- writing subscription_status = 'suspended' for a lapsed subscription
-- - the exact same value the admin panel writes when an admin
-- deliberately bans a landlord (admin.controller.js setLandlordStatus).
-- login() then treated both identically: a flat 403 "Your account has
-- been suspended. Contact RentaPay support," with no way in at all.
--
-- That's correct for an admin ban, but wrong for an expired
-- subscription - a landlord should still be able to log in and see
-- their own dashboard/data, just with a persistent "renew now" banner
-- and payment features blocked, not be locked out entirely.
--
-- This adds a distinct 'expired' status so the two cases can finally
-- be told apart. Existing 'suspended' rows are left as-is (they were
-- always meant to be an admin ban); only the job that auto-flips
-- accounts on expiry now writes 'expired' instead.
-- =====================================================================

alter table landlords drop constraint if exists landlords_subscription_status_check;
alter table landlords add constraint landlords_subscription_status_check
  check (subscription_status in ('pending', 'active', 'warning', 'expired', 'suspended'));


-- ============================================================
-- SECTION: add-expenses.sql
-- ============================================================
-- =====================================================================
-- Expense tracking. Lets a landlord/manager log property-level costs
-- (repairs, utilities, staff, etc.) so the PDF "monthly collection
-- summary" can show real net profit (collections - expenses) instead
-- of collections alone. Scoped to a property, not a unit - most
-- expenses (e.g. "roof repair", "security guard salary") apply to the
-- whole apartment rather than any one unit.
-- =====================================================================

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,

  category text not null, -- e.g. 'Repairs', 'Utilities', 'Staff', 'Other'
  amount numeric(12,2) not null check (amount > 0),
  date date not null default current_date,
  note text,
  receipt_photo_url text,

  created_by_type text not null, -- 'landlord' | 'manager'
  created_by_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_expenses_landlord on expenses(landlord_id);
create index if not exists idx_expenses_property_date on expenses(property_id, date);


-- ============================================================
-- SECTION: add-documents.sql
-- ============================================================
-- =====================================================================
-- Lease / document storage. Files themselves live in a Supabase
-- Storage bucket (see document.controller.js) - this table just
-- records the metadata + a pointer to the stored object.
--
-- ONE-TIME SETUP REQUIRED (not something SQL can do): create a
-- Storage bucket named exactly "lease-documents" in the Supabase
-- dashboard under Storage -> New bucket. Leave "Public bucket" OFF -
-- leases are sensitive, so files are served through short-lived
-- signed URLs (see document.controller.js) rather than a public URL.
--
-- Design decision (flagged, built as follows unless told otherwise):
-- landlord/manager can upload a lease to a tenant; the tenant can
-- view/download their own lease but cannot delete it - only the
-- landlord/manager who uploaded it (or another manager on the same
-- property) can remove it.
-- =====================================================================

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete cascade,
  unit_id uuid references units(id) on delete cascade,
  property_id uuid references properties(id) on delete set null,

  file_path text not null,   -- path inside the "lease-documents" bucket
  file_url text,             -- last-generated signed URL (short-lived; regenerated on read, kept only for reference)
  label text not null,       -- e.g. "Lease agreement 2026", "ID copy"
  mime_type text,
  file_size int,

  uploaded_by_type text not null, -- 'landlord' | 'manager'
  uploaded_by_id uuid not null,
  uploaded_at timestamptz not null default now()
);

create index if not exists idx_documents_landlord on documents(landlord_id);
create index if not exists idx_documents_tenant on documents(tenant_id);
create index if not exists idx_documents_unit on documents(unit_id);


-- ============================================================
-- SECTION: add-chat-messages.sql
-- ============================================================
-- =====================================================================
-- CHAT / DIRECT MESSAGING SYSTEM
-- Adds a real two-way chat between:
--   1) admin  <-> landlord   (replaces "reach us directly" with a live chat)
--   2) admin  <-> tenant     (same, from the tenant portal side)
--   3) landlord <-> tenant   ("text your landlord" inside the tenant portal,
--                             and the matching thread inside the landlord
--                             dashboard for that specific tenant)
--
-- Each row is one chat bubble. A conversation is identified by
-- (thread_type, landlord_id, tenant_id) - tenant_id is null for the
-- admin<->landlord thread, and both landlord_id/tenant_id are set for
-- the landlord<->tenant thread (tenant_id already implies landlord_id,
-- but we store both so admin can query "all threads for landlord X"
-- and "all threads for tenant Y" without a join).
--
-- reply_to_id gives the WhatsApp-style "reply to a specific bubble"
-- behaviour: the client greys out/quotes the referenced message above
-- the reply.
-- =====================================================================

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),

  thread_type text not null check (thread_type in ('admin_landlord', 'admin_tenant', 'landlord_tenant')),
  landlord_id uuid references landlords(id) on delete cascade, -- set for all thread types
  tenant_id uuid references tenants(id) on delete cascade,     -- set for admin_tenant and landlord_tenant

  sender_role text not null check (sender_role in ('admin', 'landlord', 'tenant')),
  sender_id uuid, -- landlords.id / tenants.id; null when sender_role = 'admin'
  sender_name text not null, -- snapshot at send-time so history reads fine even if the account is later renamed/removed

  body text not null,
  reply_to_id uuid references chat_messages(id) on delete set null,

  -- Read tracking is per-side (each thread only ever has two sides),
  -- rather than per-individual-admin-user, since any admin user
  -- reading a thread should mark it read for the whole admin team.
  read_by_admin boolean not null default false,
  read_by_landlord boolean not null default false,
  read_by_tenant boolean not null default false,

  created_at timestamptz not null default now()
);

-- A thread must reference the right owning IDs for its type.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_messages_thread_shape'
  ) then
    alter table chat_messages
      add constraint chat_messages_thread_shape check (
        (thread_type = 'admin_landlord' and landlord_id is not null and tenant_id is null) or
        (thread_type = 'admin_tenant'   and tenant_id is not null) or
        (thread_type = 'landlord_tenant' and landlord_id is not null and tenant_id is not null)
      );
  end if;
end $$;

create index if not exists idx_chat_admin_landlord on chat_messages(thread_type, landlord_id) where thread_type = 'admin_landlord';
create index if not exists idx_chat_admin_tenant on chat_messages(thread_type, tenant_id) where thread_type = 'admin_tenant';
create index if not exists idx_chat_landlord_tenant on chat_messages(thread_type, landlord_id, tenant_id) where thread_type = 'landlord_tenant';
create index if not exists idx_chat_created_at on chat_messages(created_at);
create index if not exists idx_chat_reply_to on chat_messages(reply_to_id);


-- ============================================================
-- SECTION: add-caretaker-role-level.sql
-- ============================================================
-- =====================================================================
-- Adds a "role_level" to property_managers so a landlord can add
-- someone as either a full Property Manager or a more limited
-- Caretaker, without needing a whole separate account table - they
-- still log in as "manager" underneath, just with fewer permissions
-- when role_level = 'caretaker'.
--
-- Caretakers can: view properties/tenants they're assigned to, remind
-- tenants, send bulk reminders, revoke a vacating notice.
-- Caretakers cannot: delete a tenant, waive interest, transfer a
-- tenant between units, add/remove units, or add extra charges.
-- (Adding/removing properties, managers, and subscription/billing
-- were already landlord-only before this and are unaffected.)
-- =====================================================================

alter table property_managers add column if not exists role_level text not null default 'manager'
  check (role_level in ('manager', 'caretaker'));


-- ============================================================
-- SECTION: add-billing-period.sql
-- ============================================================
-- Adds the column the new monthly billing job uses to make sure a
-- tenant is only ever billed once per calendar period (prevents
-- double-charging if the job runs more than once on the same day, or
-- catches up after downtime).
--
-- paid_through_date is intentionally left in place (harmless, just
-- unused going forward) rather than dropped, so no historical data is
-- lost. balance_due is now the single source of truth for what a
-- tenant owes/has as credit; see src/utils/prepayment.js.

alter table tenants add column if not exists last_billed_period text;

-- One-time backfill: for tenants who already have an active billing
-- cycle (move-in date in the past, due day already passed this
-- month), mark them as billed for the current period so the first
-- run of the new job doesn't double-charge on top of whatever
-- balance_due already reflects from the old system. Adjust the month
-- below to match whenever you actually run this migration.
update tenants
set last_billed_period = to_char(now(), 'YYYY-MM')
where is_active = true
  and last_billed_period is null
  and extract(day from now()) >= coalesce(due_day_of_month, (select due_day_of_month from units where units.id = tenants.unit_id));


-- ============================================================
-- SECTION: 2026-07-web-push-subscriptions.sql
-- ============================================================
-- =====================================================================
-- Migration: Web Push subscriptions (run once in Supabase SQL Editor,
-- after 2026-07-notifications-inbox.sql).
-- =====================================================================
-- FIX: "Live push" - urgent-tier events (payment-confirmation requests,
-- vacate notices, tenant messages) should reach a landlord/manager/
-- tenant even when the portal tab isn't open, via the browser's native
-- push notification. Everything else keeps updating quietly in-app
-- only (the existing `notifications` table), no OS-level push.
--
-- One row per browser/device a user has granted notification
-- permission on and registered a service worker for. A single account
-- can have several rows (phone + laptop, etc.) - all are pushed to.
-- =====================================================================

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),

  recipient_type text not null check (recipient_type in ('landlord', 'manager', 'tenant')),
  recipient_id uuid not null,

  endpoint text not null unique,
  p256dh text not null,
  auth text not null,

  created_at timestamptz default now()
);

create index if not exists idx_push_subscriptions_recipient
  on push_subscriptions(recipient_type, recipient_id);


-- ============================================================
-- SECTION: 2026-07-updates-v3.sql
-- ============================================================
-- =====================================================================
-- 2026-07-updates-v3.sql
--
-- Covers, in order:
--   1. Per-unit payment method override (units table).
--   2. Announcement sender tagging (Landlord / Property Manager /
--      Caretaker / System / RentaPay) + admin platform-wide broadcasts.
--   3. "Delete for me" vs "delete for everyone" on announcements.
--
-- Safe to run multiple times (every statement is guarded).
-- Run this in the Supabase SQL Editor AFTER 2026-07-announcements.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Per-unit payment method override
--
-- General/default payment method (landlords.payment_method etc.) is
-- untouched and still applies to every unit by default. These columns
-- let a specific unit override it - when payment_override_enabled is
-- true, buildPaymentInstructions() (src/utils/paymentInstructions.js)
-- prefers these fields over the landlord's own for that unit only.
-- ---------------------------------------------------------------------
alter table units add column if not exists payment_override_enabled boolean not null default false;
alter table units add column if not exists payment_override_method text
  check (payment_override_method in ('stk', 'paybill', 'till'));
alter table units add column if not exists payment_override_paybill_number text;
alter table units add column if not exists payment_override_paybill_account_number text;
alter table units add column if not exists payment_override_till_number text;

-- ---------------------------------------------------------------------
-- 2. Announcement sender tagging + platform-wide broadcasts
--
-- sender_role records who/what actually sent it, so the UI can show
-- "Landlord" / "Property Manager" / "Caretaker" / "System" / "RentaPay"
-- next to each message rather than guessing from context.
--
-- landlord_id becomes nullable + is_platform is added because an admin
-- platform-wide broadcast isn't scoped to any single landlord's
-- account at all - it goes out to literally everyone.
-- ---------------------------------------------------------------------
alter table announcements alter column landlord_id drop not null;

alter table announcements add column if not exists sender_role text not null default 'system'
  check (sender_role in ('landlord', 'manager', 'caretaker', 'system', 'platform'));
alter table announcements add column if not exists sender_id uuid;
alter table announcements add column if not exists is_platform boolean not null default false;

-- Backfill best-effort: anything already flagged is_system becomes
-- sender_role 'system'; everything else assumed sent by the landlord
-- (the old schema had no way to tell a manager's send from the
-- landlord's own, so this is a reasonable default for historical rows).
update announcements set sender_role = 'system' where is_system = true and sender_role = 'system';
update announcements set sender_role = 'landlord' where is_system = false and sender_role = 'system';

create index if not exists idx_announcements_platform on announcements(is_platform, created_at desc);

-- ---------------------------------------------------------------------
-- 3. Delete for me / delete for everyone
--
-- "Delete for everyone" (landlord/manager/caretaker only, and only for
-- announcements that belong to their own account) hard-deletes the row
-- via the existing DELETE endpoint - no new table needed for that.
--
-- "Delete for me" - available to every role, including tenants, and
-- the ONLY option tenants get - just hides the announcement for that
-- one recipient without touching it for anyone else. Same
-- recipient_type/recipient_id shape as announcement_reads for the same
-- id-collision-safety reason.
-- ---------------------------------------------------------------------
create table if not exists announcement_hidden (
  announcement_id uuid not null references announcements(id) on delete cascade,
  recipient_type text not null check (recipient_type in ('tenant', 'manager', 'landlord')),
  recipient_id uuid not null,
  hidden_at timestamptz not null default now(),
  primary key (announcement_id, recipient_type, recipient_id)
);


-- ============================================================
-- SECTION: 2026-07-updates-v2.sql
-- ============================================================
-- =====================================================================
-- Migration: 2026-07 updates v2 (run this once in Supabase SQL Editor)
-- =====================================================================
-- Adds support for:
--   1. Paid "add a new property" flow from the landlord dashboard's
--      property switcher - a landlord can register another property
--      (name + unit count), pay for those units via M-Pesa STK push,
--      and only then does the property/units become usable - mirrors
--      the same pattern as subscription_payments.
-- =====================================================================

create table if not exists property_payments (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,

  -- Property details captured up-front, applied once payment completes
  name text not null,
  location text,
  county text,
  description text,
  manager_name text,
  manager_phone text,
  units_count integer not null,

  amount numeric not null,
  mpesa_checkout_request_id text,
  mpesa_transaction_id text,
  mpesa_phone text,
  status text not null default 'pending', -- pending | completed | failed

  created_property_id uuid references properties(id) on delete set null,

  paid_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_property_payments_landlord on property_payments(landlord_id);
create index if not exists idx_property_payments_checkout on property_payments(mpesa_checkout_request_id);


-- ============================================================
-- SECTION: 2026-07-tenant-lists-and-whatsapp-group.sql
-- ============================================================
-- =====================================================================
-- 2026-07-tenant-lists-and-whatsapp-group.sql
--
-- Supports the new tenant-list Excel export (per-apartment tenant
-- list, joined-in-month, left-in-month, left-all-time) and the
-- "Add to WhatsApp Group" tab on that export.
--
-- 1. tenants.left_at - move_in_date already tracks when someone
--    joined; nothing previously tracked WHEN a tenant was archived/
--    removed/vacated, only that they currently are (is_active=false).
--    Set by tenant.controller.js deleteTenant() at the moment a
--    tenant is archived, so "left in June 2026" / "left, all time"
--    lists have a real date to filter and sort on. Existing archived
--    rows are backfilled to updated_at as a best-effort estimate.
--
-- 2. properties.whatsapp_group_id - the WhatsApp group chat id once a
--    group has been created for a given apartment's tenant list, so
--    "Add to WhatsApp Group" adds new tenants to the SAME group next
--    time instead of creating a duplicate group on every use.
--
-- Safe to run multiple times (every statement is guarded).
-- =====================================================================

alter table tenants add column if not exists left_at timestamptz;
update tenants set left_at = updated_at where is_active = false and left_at is null;

create index if not exists idx_tenants_left_at on tenants(left_at);
create index if not exists idx_tenants_move_in_date on tenants(move_in_date);

alter table properties add column if not exists whatsapp_group_id text;


-- ============================================================
-- SECTION: 2026-07-scout-exclusivity-and-constituency.sql
-- ============================================================
-- =====================================================================
-- 1) Landlord constituency, alongside the existing county field.
--    Same setup-wizard step (blueprint 3.2) as county - required going
--    forward, so a landlord's location can be filtered by county AND
--    constituency, not just county. Mirrors properties.county's
--    per-property version below.
-- =====================================================================
alter table landlords add column if not exists constituency text;
alter table properties add column if not exists constituency text;
alter table property_payments add column if not exists constituency text;

-- =====================================================================
-- 2) SCOUT EXCLUSIVITY (app-code change, documented here for the
--    record - no schema change was required for this part since
--    scouts was always its own table with its own unique phone index;
--    the enforcement lives in src/utils/phoneUniqueness.js and
--    src/controllers/scout.controller.js). A Scout account can no
--    longer share a phone number with a landlord/manager/tenant
--    account. This does NOT retroactively touch any existing rows -
--    if a dual-role account already exists in this environment from
--    before the change, it keeps working via the login() account
--    picker; only NEW registrations are blocked from creating another.
--    Run this query to check whether any such accounts exist and
--    decide by hand what (if anything) to do about them:
--
--   select s.id as scout_id, s.phone, l.id as landlord_id
--     from scouts s join landlords l on l.phone = s.phone
--   union all
--   select s.id, s.phone, pm.id
--     from scouts s join property_managers pm on pm.phone = s.phone
--   union all
--   select s.id, s.phone, t.id
--     from scouts s join tenants t on t.primary_phone = s.phone and t.is_active = true;
-- =====================================================================


-- ============================================================
-- SECTION: 2026-07-property-payments-caretaker.sql
-- ============================================================
-- =====================================================================
-- Follow-up to 2026-07-property-managers.sql: the "buy a new property"
-- flow (property.controller.js initiatePropertyPurchase / purchase-
-- Property in the frontend) was still writing the pre-migration
-- manager_name / manager_phone columns on property_payments, which are
-- never read anywhere else now that properties uses caretaker_name /
-- caretaker_phone. This adds the matching caretaker columns here too
-- so a caretaker set while paying for a brand-new property actually
-- survives onto the created properties row.
-- Run this in the Supabase SQL Editor AFTER 2026-07-property-managers.sql.
-- =====================================================================
alter table property_payments add column if not exists caretaker_name text;
alter table property_payments add column if not exists caretaker_phone text;

-- The old manager_name / manager_phone columns are kept (nothing is
-- deleted per project convention) but are no longer read or written.


-- ============================================================
-- SECTION: 2026-07-property-payment-method.sql
-- ============================================================
-- =====================================================================
-- 2026-07-property-payment-method.sql
--
-- BUG: a landlord with more than one apartment/property who updated
-- "the payment method" was actually updating landlords.payment_method
-- - a single column on the landlord's own row - which every property
-- they own reads from. So editing the payment method while viewing
-- Apartment A silently changed what Apartment B's tenants were told
-- to pay to as well.
--
-- FIX: give `properties` the exact same override pattern units already
-- have (see 2026-07-updates-v3.sql, section 1). When
-- payment_override_enabled is true on a property, buildPaymentInstructions()
-- prefers these fields for every unit in that property - UNLESS that
-- specific unit has its own unit-level override switched on, which
-- still wins (most specific override wins: unit > property > landlord
-- default).
--
-- Safe to run multiple times (every statement is guarded).
-- =====================================================================

alter table properties add column if not exists payment_override_enabled boolean not null default false;
alter table properties add column if not exists payment_override_method text
  check (payment_override_method in ('stk', 'paybill', 'till'));
alter table properties add column if not exists payment_override_paybill_number text;
alter table properties add column if not exists payment_override_paybill_account_number text;
alter table properties add column if not exists payment_override_till_number text;


-- ============================================================
-- SECTION: 2026-07-property-managers.sql
-- ============================================================
-- =====================================================================
-- Property Managers (second-party portal access) + Caretaker fields
-- + Scheduled rent changes with an effective date.
-- Run this in the Supabase SQL Editor AFTER schema.sql and the other
-- migrations in this folder.
-- =====================================================================

-- ---------------------------------------------------------------------
-- CARETAKER fields on properties - separate from the property manager,
-- who is now a real login account (see below). Caretaker is just a
-- contact record, editable any time, no login.
-- ---------------------------------------------------------------------
alter table properties add column if not exists caretaker_name text;
alter table properties add column if not exists caretaker_phone text;

-- The old manager_name / manager_phone free-text columns are kept
-- (nothing is deleted per project convention) but are no longer read
-- or written by the app - the property_managers table below is now
-- the source of truth for "who is the property manager".

-- ---------------------------------------------------------------------
-- PROPERTY MANAGERS  (second-party accounts, added by a landlord,
-- log in with their own credentials, see the same portal as the
-- landlord but with some actions locked - see auth.middleware.js)
-- ---------------------------------------------------------------------
create table if not exists property_managers (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,

  full_name text not null,
  phone text not null unique,
  email text,
  photo_url text,
  password_hash text not null,

  otp_code text,
  otp_expires_at timestamptz,
  is_verified boolean default false,
  must_change_password boolean default true,

  is_active boolean default true, -- landlord can deactivate without deleting

  failed_login_attempts int default 0,
  locked_until timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_property_managers_landlord on property_managers(landlord_id);
create index if not exists idx_property_managers_phone on property_managers(phone);

drop trigger if exists trg_property_managers_updated_at on property_managers;
create trigger trg_property_managers_updated_at before update on property_managers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- PROPERTY MANAGER ASSIGNMENTS  (which properties a given manager may
-- actually manage - many-to-many so a landlord with several
-- properties can either give one manager all of them or split access
-- per property). A manager still SEES every property belonging to
-- their landlord in listings; opening one they're not assigned to
-- is blocked at the API level with a clear "not authorized" message
-- rather than being hidden, per the landlord's request.
-- ---------------------------------------------------------------------
create table if not exists property_manager_assignments (
  id uuid primary key default gen_random_uuid(),
  property_manager_id uuid not null references property_managers(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  created_at timestamptz default now(),
  unique (property_manager_id, property_id)
);

create index if not exists idx_pm_assignments_manager on property_manager_assignments(property_manager_id);
create index if not exists idx_pm_assignments_property on property_manager_assignments(property_id);

-- ---------------------------------------------------------------------
-- SCHEDULED RENT CHANGES  (blueprint addition: changing a unit's rent
-- now requires an effective date - immediately, next billing month,
-- or a specific future date - instead of overwriting rent_amount on
-- the spot).
-- ---------------------------------------------------------------------
create table if not exists rent_changes (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,

  old_amount numeric(12,2) not null,
  new_amount numeric(12,2) not null,
  effective_date date not null,

  status text check (status in ('pending', 'applied', 'cancelled')) default 'pending',

  created_by_type text check (created_by_type in ('landlord', 'manager')) not null,
  created_by_id uuid not null,

  applied_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_rent_changes_unit on rent_changes(unit_id);
create index if not exists idx_rent_changes_status on rent_changes(status);

-- ---------------------------------------------------------------------
-- CONTACT DETAILS shown to tenants: rather than every tenant screen
-- reading landlords.phone directly (which breaks the "show the
-- property manager's contact instead, when one is assigned" rule),
-- units gain an optional pointer to which property_manager currently
-- "owns" tenant-facing contact info for that unit's property. Null =
-- fall back to the landlord's own contact details.
-- ---------------------------------------------------------------------
alter table properties add column if not exists primary_contact_manager_id uuid references property_managers(id) on delete set null;


-- ============================================================
-- SECTION: 2026-07-notifications-inbox.sql
-- ============================================================
-- =====================================================================
-- Migration: in-portal notifications inbox (run once in Supabase SQL
-- Editor, after the other 2026-07-*.sql migrations).
-- =====================================================================
-- FIX: "when sending any reminder, be it bulk or any updates or
-- announcements, the message should be sent to the tenant's phone
-- number as well as the portal's inbox."
--
-- chat_messages (add-chat-messages.sql) is a two-party thread between
-- a specific admin/landlord/tenant pair - it's the wrong shape for a
-- one-way system notification that should show up in EVERY relevant
-- portal's inbox regardless of who's chatting with whom. This is a
-- separate, simple one-way notifications table instead: every SMS the
-- system already sends (rent reminders, overdue alerts, bulk
-- reminders, announcements, manager/caretaker changes, etc.) now also
-- writes one row here, and the portals show it under a bell/inbox
-- icon. Nothing about chat_messages changes.
-- =====================================================================

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),

  recipient_type text not null check (recipient_type in ('landlord', 'manager', 'tenant')),
  recipient_id uuid not null,

  title text not null,
  body text not null,

  category text default 'general', -- 'rent_reminder' | 'overdue' | 'announcement' | 'account' | 'general'

  read_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_notifications_recipient on notifications(recipient_type, recipient_id, created_at desc);
create index if not exists idx_notifications_unread on notifications(recipient_type, recipient_id) where read_at is null;


-- ============================================================
-- SECTION: 2026-07-fixes.sql
-- ============================================================
-- =====================================================================
-- Migration: 2026-07 fixes (run this once in Supabase SQL Editor)
-- =====================================================================
-- Safe to run even if some of these already exist / are already
-- correct - everything below uses "if not exists" / idempotent
-- updates. This single script brings your live database in sync with
-- the current schema.sql, regardless of which earlier sql/*.sql files
-- you already ran.
--
-- WHAT THIS FIXES:
--
-- 1. "Could not find the 'must_change_password' column of 'landlords'
--    in the schema cache" - the changePassword endpoint tried to write
--    this column for BOTH landlords and tenants, but it only ever
--    existed on tenants. Every landlord password change (forced or
--    voluntary) was failing.
--
-- 2. Phone numbers stored inconsistently (some as "0712345678", some
--    as "254712345678") - the root cause behind "no matching account
--    found", the onboarding loop, and "invalid code" on forgot-
--    password for anyone who typed their number differently at
--    different points. The backend now normalizes every phone number
--    going forward (see src/utils/phone.js) - this migration
--    normalizes what's already stored so existing accounts are fixed
--    retroactively too.
--
-- 3. Adds `properties` + a manager contact, for landlords who run more
--    than one rental property (see the "multi-property" section
--    below and PROPERTIES_AND_MULTI_LOCATION.md for the full design).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. must_change_password on landlords
-- ---------------------------------------------------------------------
alter table landlords add column if not exists must_change_password boolean default false;

-- ---------------------------------------------------------------------
-- 2. Normalize existing phone numbers to 2547XXXXXXXX / 2541XXXXXXXX
-- ---------------------------------------------------------------------
-- Strips spaces/dashes, then rewrites leading "0" or "+254" to "254".
-- Numbers that don't match a recognizable Kenyan shape are left
-- untouched (regex guards against mangling already-correct or
-- genuinely invalid data) - check the two "still not normalized"
-- SELECTs at the bottom afterward and fix any stragglers by hand.

update landlords
set phone = '254' || regexp_replace(phone, '^(?:\+?254|0)', '')
where phone ~ '^0[17][0-9]{8}$' or phone ~ '^\+?254[17][0-9]{8}$';

update tenants
set primary_phone = '254' || regexp_replace(primary_phone, '^(?:\+?254|0)', '')
where primary_phone ~ '^0[17][0-9]{8}$' or primary_phone ~ '^\+?254[17][0-9]{8}$';

update tenants
set secondary_phone = '254' || regexp_replace(secondary_phone, '^(?:\+?254|0)', '')
where secondary_phone is not null
  and (secondary_phone ~ '^0[17][0-9]{8}$' or secondary_phone ~ '^\+?254[17][0-9]{8}$');

update tenants
set emergency_contact_phone = '254' || regexp_replace(emergency_contact_phone, '^(?:\+?254|0)', '')
where emergency_contact_phone ~ '^0[17][0-9]{8}$' or emergency_contact_phone ~ '^\+?254[17][0-9]{8}$';

-- Run these two after the updates above - anything they return is a
-- number this script couldn't confidently normalize (typo, landline,
-- foreign number, etc.) and needs a manual look:
--   select id, full_name, phone from landlords where phone !~ '^254[17][0-9]{8}$';
--   select id, full_name, primary_phone from tenants where primary_phone !~ '^254[17][0-9]{8}$';

-- ---------------------------------------------------------------------
-- 3. Multi-property support
-- ---------------------------------------------------------------------
-- A landlord who owns more than one rental property (different
-- estates in different locations) now gets real "properties" they can
-- switch between, instead of everything being flattened onto the one
-- estate_name/location/county on the landlords row.
--
-- Backward compatible: property_id on units is NULLABLE. Existing
-- units keep working exactly as before (ungrouped / "default
-- property"); a landlord only needs to create Property rows if they
-- actually want to split their units across locations.

create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,

  name text not null,             -- e.g. "Greenwood Apartments"
  location text,
  county text,
  description text,

  -- Optional property manager contact, shown to that property's
  -- tenants alongside the landlord's own contact (in the tenant
  -- portal + Help screen) - for landlords who have staff running a
  -- given site day-to-day.
  manager_name text,
  manager_phone text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_properties_landlord on properties(landlord_id);

alter table units add column if not exists property_id uuid references properties(id) on delete set null;
create index if not exists idx_units_property on units(property_id);

-- One-time convenience: for a landlord who already filled in
-- estate_name/location/county on their landlords row (the old single-
-- property fields), create a matching Property row and attach all of
-- their existing units to it, so they see continuity instead of an
-- empty properties list the first time they open the switcher.
-- Skips landlords who already have at least one property row (safe to
-- re-run).
insert into properties (landlord_id, name, location, county)
select l.id, coalesce(nullif(l.estate_name, ''), l.full_name || '''s property'), l.location, l.county
from landlords l
where l.estate_name is not null
  and not exists (select 1 from properties p where p.landlord_id = l.id);

update units u
set property_id = p.id
from properties p
where p.landlord_id = u.landlord_id
  and u.property_id is null
  and p.id = (select id from properties where landlord_id = u.landlord_id order by created_at asc limit 1);

drop trigger if exists trg_properties_updated_at on properties;
create trigger trg_properties_updated_at before update on properties
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 4. Help requests admin view (item F): resolved_at/resolution_note
--    for the new admin "Help Requests" tab.
-- ---------------------------------------------------------------------
alter table help_requests add column if not exists resolved_at timestamptz;
alter table help_requests add column if not exists resolution_note text;


-- ============================================================
-- SECTION: 2026-07-chat-delete.sql
-- ============================================================
-- =====================================================================
-- Item 5: chat "delete for me" / "delete for everyone".
--
-- Mirrors the announcements pattern (announcement_hidden +
-- delete-scope logic in announcement.controller.js) rather than
-- inventing a new shape:
--
--   'self'     - hides the message for the requesting viewer only.
--                Always allowed, for any participant, on any message.
--   'everyone' - actually deletes the message body for the whole
--                thread. Gated by role, per the rules you gave:
--                  - a RentaPay/admin-authored message can NEVER be
--                    deleted for everyone, by anyone (including admin).
--                  - a caretaker's own message can only be deleted for
--                    everyone by a manager or landlord on that same
--                    account - the caretaker who sent it cannot do
--                    this themselves (they can still delete it for
--                    themselves only).
--                  - everyone else (landlord/manager/tenant) can have
--                    their own message deleted for everyone by
--                    themselves, or by a landlord/full manager on that
--                    same account (day-to-day moderation), or by
--                    admin.
--                See chat.controller.js `deleteMessage` for the exact
--                enforcement - this migration only adds the storage.
--
-- BONUS FIX (found while wiring this up, not on the original punch
-- list): chat_messages.sender_role's check constraint only allowed
-- ('admin','landlord','tenant') - it never included 'manager'. Since
-- the item 6/7 fix added a manager branch to resolveScope/sendMessage
-- that inserts sender_role = 'manager' for a property
-- manager/caretaker texting a tenant, every one of those sends would
-- have failed the DB check constraint outright. Widening the
-- constraint here and adding sender_role_level so a caretaker's
-- messages can be told apart from a full manager's (needed for the
-- "caretaker's own message" rule above).
-- =====================================================================

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_sender_role_check') then
    alter table chat_messages drop constraint chat_messages_sender_role_check;
  end if;
end $$;

alter table chat_messages
  add constraint chat_messages_sender_role_check
  check (sender_role in ('admin', 'landlord', 'manager', 'tenant'));

alter table chat_messages add column if not exists sender_role_level text
  check (sender_role_level in ('manager', 'caretaker'));

-- Delete-for-everyone: soft delete. We keep the row (so reply_to
-- quoting of a deleted message can still render "This message was
-- deleted" instead of a dangling reference) but blank the body and
-- flag it.
alter table chat_messages add column if not exists deleted_for_everyone boolean not null default false;
alter table chat_messages add column if not exists deleted_at timestamptz;
alter table chat_messages add column if not exists deleted_by_role text
  check (deleted_by_role in ('admin', 'landlord', 'manager', 'tenant'));

-- Delete-for-me: same shape as announcement_hidden.
create table if not exists chat_message_hidden (
  message_id uuid not null references chat_messages(id) on delete cascade,
  viewer_role text not null check (viewer_role in ('admin', 'landlord', 'manager', 'tenant')),
  viewer_id uuid not null,
  hidden_at timestamptz not null default now(),
  primary key (message_id, viewer_role, viewer_id)
);

create index if not exists idx_chat_message_hidden_viewer on chat_message_hidden(viewer_role, viewer_id);


-- ============================================================
-- SECTION: 2026-07-backfill-landlord-subscription-expiry.sql
-- ============================================================
-- =====================================================================
-- Backfill: subscription_expires_at was never set on a landlord's
-- FIRST activation (only on renewals - see activateLandlordAfterPayment
-- in auth.controller.js, now fixed to set it going forward). Any
-- landlord who activated before that fix is stuck with a null expiry
-- until it's patched manually - this is exactly the "subscription
-- counter is normally null until I go adjust it in Supabase myself"
-- report. Run this ONCE against existing data; new activations no
-- longer need it.
--
-- Only touches landlords that are genuinely active/verified with a
-- missing expiry - never a still-pending signup (those correctly have
-- no expiry yet; they haven't paid) and never a landlord whose expiry
-- is already set (a real renewal, or already manually patched).
-- =====================================================================

update landlords
set subscription_expires_at = coalesce(subscription_started_at, updated_at, now())
                               + (coalesce(subscription_period_months, 1) || ' months')::interval
where subscription_expires_at is null
  and is_verified = true
  and subscription_status in ('active', 'warning', 'expired', 'suspended');

-- Sanity check: run this after the update above - should return 0 rows.
-- select id, full_name, phone, subscription_status, subscription_started_at, subscription_expires_at
-- from landlords
-- where subscription_expires_at is null and is_verified = true and subscription_status in ('active', 'warning', 'expired', 'suspended');


-- ============================================================
-- SECTION: 2026-07-announcements.sql
-- ============================================================
-- =====================================================================
-- Announcements: a landlord broadcasts a message to everyone attached
-- to their account (tenants, property managers, caretakers). Shown as
-- a bell icon with an unread count in every portal (except admin).
--
-- One row per announcement. Read state is tracked per-recipient in a
-- small join table rather than one big array column, so "mark as
-- read" is a simple upsert and doesn't require rewriting the whole
-- announcement row (avoids write contention if many tenants open it
-- around the same time).
--
-- Run this in the Supabase SQL Editor after the other migrations in
-- this folder.
-- =====================================================================

create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  message text not null,
  -- Who this was sent to: 'all' (everyone), or a specific property, so
  -- a landlord can message just one apartment's tenants if they want.
  -- NULL property_id + audience 'all' = literally everyone.
  property_id uuid references properties(id) on delete cascade,
  audience text not null default 'all' check (audience in ('all', 'property')),
  -- System-generated announcements (e.g. "payment method changed") are
  -- flagged so the UI can style them slightly differently if desired,
  -- and so they're excluded from any "delete my announcement" UI later.
  is_system boolean default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_announcements_landlord on announcements(landlord_id, created_at desc);

-- Tracks who has read which announcement. recipient_type distinguishes
-- id collisions across tenants/property_managers (both use uuid pk's
-- from different tables, so in practice collisions are astronomically
-- unlikely, but being explicit costs nothing and avoids ever trusting
-- an id in isolation).
create table if not exists announcement_reads (
  announcement_id uuid not null references announcements(id) on delete cascade,
  recipient_type text not null check (recipient_type in ('tenant', 'manager', 'landlord')),
  recipient_id uuid not null,
  read_at timestamptz not null default now(),
  primary key (announcement_id, recipient_type, recipient_id)
);


-- ============================================================
-- SECTION: 2026-07-announcements-unit-scope.sql
-- ============================================================
-- =====================================================================
-- Item 9: unit-scoped announcements.
--
-- Every "Unit X's rent/due date/extra charge/payment method has
-- changed" system announcement was being sent with audience='property'
-- - visible to every tenant in the whole apartment/property, not just
-- the one tenant whose unit actually changed. A rent change on Unit 4B
-- has no business showing up in Unit 2A's notification feed.
--
-- Adds a third, more specific audience level: 'unit'. Existing 'all'
-- and 'property' broadcasts (announcements sent by a landlord/manager/
-- caretaker to the whole account or one property) are untouched.
-- =====================================================================

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'announcements_audience_check') then
    alter table announcements drop constraint announcements_audience_check;
  end if;
end $$;

alter table announcements
  add constraint announcements_audience_check check (audience in ('all', 'property', 'unit'));

alter table announcements add column if not exists unit_id uuid references units(id) on delete cascade;

create index if not exists idx_announcements_unit on announcements(unit_id) where unit_id is not null;


-- ============================================================
-- SECTION: add-scout-push-notifications.sql
-- ============================================================
-- =====================================================================
-- Migration: Scout push notifications (run once in Supabase SQL
-- Editor, after 2026-07-web-push-subscriptions.sql and
-- add-scout-role.sql).
-- =====================================================================
-- FIX (Pass 2, item 3 - "Scout push notifications"): push_subscriptions
-- previously only recognized recipient_type of 'landlord' / 'manager' /
-- 'tenant', so a Scout had no way to register for live push at all -
-- the frontend call would succeed (nothing validates recipient_type on
-- write besides this constraint) but a Scout's push.controller.js
-- recipientFor() branch didn't exist, so nothing to check yet. This
-- widens the constraint the same way add-scout-role.sql widened
-- chat_messages/every other cross-role check constraint in this
-- codebase, so 'scout' rows are actually valid before the app tries to
-- write them.
-- =====================================================================

alter table push_subscriptions drop constraint if exists push_subscriptions_recipient_type_check;
alter table push_subscriptions add constraint push_subscriptions_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant', 'scout'));


-- ============================================================
-- SECTION: add-scout-help-and-announcements.sql
-- ============================================================
-- =====================================================================
-- Migration: Scout help requests + platform announcements (Pass 2,
-- item 2). Run once in Supabase SQL Editor, after add-scout-role.sql
-- and 2026-07-updates-v3.sql / add-platform-message-targeting.sql.
-- =====================================================================
-- FIX: a Scout had no way to submit a help request, appear in an
-- admin-side help-request queue, receive an in-portal notification, or
-- be targeted by an admin platform-wide broadcast - every one of these
-- was gated by a check constraint that only knew about
-- landlord/tenant/manager/guest. This widens each of them the same way
-- add-scout-role.sql widened chat_messages, so 'scout' rows are valid
-- before the app tries to write them. No new tables - Scouts reuse the
-- exact same help_requests / notifications / announcements machinery
-- everyone else already uses.
-- =====================================================================

-- Scouts can now submit help requests (ComplaintsPanel, reused as-is
-- in the Scout portal) and appear in the admin help-request queue.
alter table help_requests drop constraint if exists help_requests_requester_type_check;
alter table help_requests add constraint help_requests_requester_type_check
  check (requester_type in ('landlord', 'tenant', 'guest', 'scout'));

-- Scouts can now receive in-portal notification-inbox rows (used by
-- notify(), e.g. when a platform announcement is fanned out to them).
alter table notifications drop constraint if exists notifications_recipient_type_check;
alter table notifications add constraint notifications_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant', 'scout'));

-- Scouts can now mark platform announcements read / hide them for
-- themselves, same as every other role.
alter table announcement_reads drop constraint if exists announcement_reads_recipient_type_check;
alter table announcement_reads add constraint announcement_reads_recipient_type_check
  check (recipient_type in ('tenant', 'manager', 'landlord', 'scout'));

alter table announcement_hidden drop constraint if exists announcement_hidden_recipient_type_check;
alter table announcement_hidden add constraint announcement_hidden_recipient_type_check
  check (recipient_type in ('tenant', 'manager', 'landlord', 'scout'));

-- Admin's platform-wide broadcast gets a fourth target-group option -
-- Scouts are their own audience, not part of "tenants" or the
-- landlord/manager/caretaker "landlord_team" group, and were
-- previously only reachable via 'all' (or not reachable at all, since
-- fanOutAnnouncementPush didn't query scouts under any group).
alter table announcements drop constraint if exists announcements_platform_target_group_check;
alter table announcements add constraint announcements_platform_target_group_check
  check (platform_target_group in ('all', 'tenants', 'landlord_team', 'scouts'));


-- ============================================================
-- SECTION: 2026-07-manual-payment-duplicate-flagging.sql
-- ============================================================
-- =====================================================================
-- Direct request: "a landlord or scout can decide to submit again a
-- code that has been used already...in the admin side it does not
-- flag this like how the tenants side is flagged and marked...the
-- same principle should apply."
--
-- pending_payment_confirmations (tenant-side) already has a
-- `duplicate_of` column (add-payment-confirmation-resubmission.sql)
-- pointing at the earlier CONFIRMED record with the same transaction
-- code, so the admin/landlord UI can flag "this M-Pesa code was
-- already used" instead of silently letting it through again.
-- landlord_manual_subscription_payments and scout_manual_county_
-- payments never got the same column, so the exact same reused-code
-- scenario on those two flows had nothing to flag it with at all.
-- =====================================================================

alter table landlord_manual_subscription_payments
  add column if not exists duplicate_of uuid references landlord_manual_subscription_payments(id) on delete set null;

alter table scout_manual_county_payments
  add column if not exists duplicate_of uuid references scout_manual_county_payments(id) on delete set null;

create index if not exists idx_landlord_manual_sub_payments_duplicate_of on landlord_manual_subscription_payments(duplicate_of);
create index if not exists idx_scout_manual_county_payments_duplicate_of on scout_manual_county_payments(duplicate_of);


-- ============================================================
-- SECTION: add-scout-referrals.sql
-- ============================================================
-- =====================================================================
-- SCOUT REFERRAL TRACKING & NOTIFICATIONS
--
-- 1) units.last_verified_at - separate from updated_at. Stamped only
--    when a landlord/manager/caretaker explicitly taps "Still vacant -
--    confirm" (PATCH /units/:id/verify). Kept distinct from
--    updated_at deliberately: a rent-amount typo fix or any other edit
--    also bumps updated_at, which would falsely read as "freshly
--    confirmed vacant" to a scout browsing the vacancy list.
-- =====================================================================
alter table units add column if not exists last_verified_at timestamptz;

-- =====================================================================
-- 2) scout_referrals - single source of truth for the referral
--    pipeline: a scout shares a vacant unit with a prospective tenant
--    (status 'shared'), a landlord/manager/caretaker opens the referral
--    (status 'viewed_by_landlord'), and if the unit gets rented within
--    the credit window, the referral is auto-credited as a 'placed'
--    placement. 'expired' is reserved for a future cleanup job/view
--    that marks referrals past the placement-credit window as no
--    longer active, so old shares stop showing as "active" badges/
--    Attention Feed items - nothing currently writes 'expired'
--    directly; it's computed by filtering on shared_at age wherever
--    "active referral" is checked (see scoutReferral.service.js).
-- =====================================================================
create table if not exists scout_referrals (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid not null references scouts(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,
  status text not null default 'shared' check (status in ('shared', 'viewed_by_landlord', 'placed', 'expired')),
  shared_at timestamptz not null default now(),
  viewed_at timestamptz,
  placed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Fast "does this scout already have a recent referral for this unit"
-- check (used for the 24h SMS re-notify cooldown) and fast "active
-- referrals for this unit/landlord" lookups (badge, Attention Feed,
-- placement credit).
create index if not exists idx_scout_referrals_scout_unit on scout_referrals(scout_id, unit_id, shared_at desc);
create index if not exists idx_scout_referrals_unit on scout_referrals(unit_id, status);
create index if not exists idx_scout_referrals_landlord on scout_referrals(landlord_id, status, shared_at desc);


-- ============================================================
-- SECTION: 2026-07-admin-notifications-support.sql
-- ============================================================
-- =====================================================================
-- Direct request: "in admin also should be notified on payment
-- submissions for scouts and landlords" + "notifications should look
-- native" (in-app bell + real OS push for admin too).
--
-- Root cause admin could never be notified in-app or via push: both
-- notifications.recipient_id and push_subscriptions.recipient_id are
-- `uuid` columns, but the admin account's id is the literal STRING
-- 'super-admin' (see auth.controller.js signToken({ id: 'super-admin',
-- role: 'admin' })) - not a real uuid. Any insert/query using that id
-- against a uuid column throws a Postgres type error, so it silently
-- failed everywhere it was tried.
--
-- Widening recipient_id to text is safe: existing uuid values still
-- compare/print identically as text, and every other recipient type
-- (landlord/manager/tenant/scout) keeps working exactly as before -
-- only the RANGE of accepted ids gets wider, not the query shape.
-- =====================================================================

alter table notifications alter column recipient_id type text using recipient_id::text;
alter table push_subscriptions alter column recipient_id type text using recipient_id::text;

alter table notifications drop constraint if exists notifications_recipient_type_check;
alter table notifications add constraint notifications_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant', 'scout', 'admin'));

alter table push_subscriptions drop constraint if exists push_subscriptions_recipient_type_check;
alter table push_subscriptions add constraint push_subscriptions_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant', 'scout', 'admin'));

-- VERIFICATION:
--   select data_type from information_schema.columns where table_name='notifications' and column_name='recipient_id'; -- should be 'text'
--   select data_type from information_schema.columns where table_name='push_subscriptions' and column_name='recipient_id'; -- should be 'text'


-- ============================================================
-- SECTION: 2026-07-performance-indexes.sql
-- ============================================================
-- Additive, safe to run any time - just an index, no schema/behavior change.
--
-- `payments` already had idx_payments_landlord(landlord_id) and
-- idx_payments_tenant(tenant_id) separately, but the dashboard's
-- "paid this month" figure and the annual report both filter by
-- landlord_id AND a paid_at date range together - neither existing
-- index serves that combined filter well.
create index if not exists idx_payments_landlord_paid_at on payments(landlord_id, paid_at);


-- ============================================================
-- SECTION: 2026-07-notifications-property-scope.sql
-- ============================================================
-- =====================================================================
-- Direct request: "every apartment be solely independent... not
-- sharing anything across any apartments... even notifications...
-- nothing should leak."
--
-- notifications was keyed only by (recipient_type, recipient_id) - for
-- a landlord that recipient_id is their ONE account, so every
-- notification about every property they own (rent reminders,
-- payment receipts, maintenance reports, tenant messages...) landed
-- in the exact same inbox with no way to tell them apart, let alone
-- filter the inbox down to just the apartment currently selected in
-- the property switcher.
--
-- Adding property_id lets notify() tag a notification with whichever
-- property it's actually about (see notify.service.js), and lets
-- listNotifications (notifications.controller.js) filter the inbox to
-- just the active property - genuinely account-wide notices (a
-- password change, a new manager added, a subscription-wide notice on
-- the landlord's own original/pooled property) keep property_id null
-- and still show up regardless of which apartment is selected, same
-- as the shared phone number/profile.
-- =====================================================================

alter table notifications add column if not exists property_id uuid references properties(id) on delete set null;

create index if not exists idx_notifications_recipient_property on notifications(recipient_type, recipient_id, property_id, created_at desc);


-- ============================================================
-- SECTION: 2026-07-notification-style-preference.sql
-- ============================================================
-- =====================================================================
-- Direct request: "when notifications land in... they should not
-- land in silently... they should be default according to the user
-- profiles. if its vibrate they vibrate if ring they ring the users
-- notification tone."
--
-- Adds a stored preference so a push notification can ask the device
-- to vibrate vs. play the normal notification sound vs. stay fully
-- quiet, instead of every device just getting whatever it happened to
-- default to. See webpush.service.js for how this is read and turned
-- into the actual push payload, and Settings.jsx for where a landlord
-- picks their own.
--
-- Important, real limitation (documented here so it isn't
-- "discovered" as a bug later): the Web Push / Notification API lets
-- a site request vibration (a pattern) or ask for a fully silent
-- notification, but it can NOT choose or play a *custom ringtone* -
-- that decision belongs entirely to the phone's own OS/notification-
-- channel settings, the same as every other app's notifications. 
-- 'ring' here means "don't suppress sound - let the OS play its
-- normal notification sound", not "play a specific tone".
-- =====================================================================

alter table landlords add column if not exists notification_style text check (notification_style in ('ring', 'vibrate', 'silent')) default 'ring';
alter table tenants add column if not exists notification_style text check (notification_style in ('ring', 'vibrate', 'silent')) default 'ring';
alter table property_managers add column if not exists notification_style text check (notification_style in ('ring', 'vibrate', 'silent')) default 'ring';


-- ============================================================
-- SECTION: 2026-07-shorten-otp-expiry-windows.sql
-- ============================================================
-- =====================================================================
-- Direct request: shorten OTP/credential expiry windows.
--   - First-time login details (temp password + OTP handed to a new
--     tenant/manager/caretaker/scout): 3 days -> 24 hours.
--   - Password-reset codes: now 5 minutes (previously shared the same
--     3-day window as everything else - see auth.controller.js /
--     utils/otp.js for the application-level change; this migration
--     just brings the DB-level default on first_time_credentials in
--     line with the new 24h app-level value, since the app now always
--     sets expires_at explicitly on insert anyway).
-- =====================================================================

alter table first_time_credentials
  alter column expires_at set default (now() + interval '24 hours');

-- Existing rows created under the old 14-day default are left as-is
-- (already-issued codes keep whatever expiry they were promised) -
-- only new rows going forward use the shorter window.


-- ============================================================
-- SECTION: add-scout-profile-photo.sql
-- ============================================================
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


-- ============================================================
-- SECTION: add-otp-attempt-limiting.sql
-- ============================================================
-- =====================================================================
-- SECURITY FIX: verifyOTP had no brute-force protection at all - it
-- just compared otp_code === otp with no attempt counter, unlike the
-- login endpoint (which already has failed_login_attempts/locked_until
-- and a 30-minute lockout). A 6-digit OTP is only ~1,000,000
-- possibilities, so an unthrottled endpoint is realistically
-- guessable with a scripted loop. This adds the same style of
-- lockout, scoped separately from login attempts since OTP
-- verification is a different code path with its own risk window
-- (right after signup/resend, before the account is even verified).
-- =====================================================================

alter table landlords add column if not exists otp_failed_attempts integer not null default 0;
alter table landlords add column if not exists otp_locked_until timestamptz;

alter table tenants add column if not exists otp_failed_attempts integer not null default 0;
alter table tenants add column if not exists otp_locked_until timestamptz;

alter table scouts add column if not exists otp_failed_attempts integer not null default 0;
alter table scouts add column if not exists otp_locked_until timestamptz;

alter table property_managers add column if not exists otp_failed_attempts integer not null default 0;
alter table property_managers add column if not exists otp_locked_until timestamptz;


-- ============================================================
-- SECTION: add-unit-photos.sql
-- ============================================================
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


-- ============================================================
-- SECTION: add-scout-referral-payouts.sql
-- ============================================================
-- =====================================================================
-- FEATURE (direct request: scout referral payout tracking). Right now
-- a scout gets attribution credit (status flips to 'placed') and the
-- landlord gets notified, but there is no in-app record of whether the
-- scout was ever actually paid for that placement - the whole
-- financial side happens off-platform with nothing to show for it.
-- This adds a payout column set an admin can update once a scout has
-- actually been paid (however that payment happened - M-Pesa,
-- cash, etc. - this just records that it did, not how).
-- =====================================================================

alter table scout_referrals add column if not exists payout_status text not null default 'not_applicable'
  check (payout_status in ('not_applicable', 'pending', 'paid'));
alter table scout_referrals add column if not exists payout_amount numeric(10,2);
alter table scout_referrals add column if not exists payout_note text;
alter table scout_referrals add column if not exists payout_paid_at timestamptz;

-- The moment a referral flips to 'placed' (see
-- scoutReferral.service.js's creditPlacementIfEligible), its
-- payout_status should move from 'not_applicable' to 'pending' so it
-- shows up in the admin's "owed to scouts" queue - handled in the
-- application code alongside that same status flip, not here, since
-- it depends on the placement-credit business logic already there.

create index if not exists idx_scout_referrals_payout_status on scout_referrals(payout_status, placed_at desc);


-- ============================================================
-- SECTION: add-onboarding-checklist.sql
-- ============================================================
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


-- ============================================================
-- SECTION: 2026-07-community-board.sql
-- ============================================================
-- =====================================================================
-- Community board + marketplace: a tenant<->tenant space, scoped to
-- "everyone in this property". Separate from announcements
-- (landlord->tenant, one-way) and help/complaints (tenant->landlord,
-- private) - this is the first genuinely peer-to-peer surface in the
-- app.
--
-- One table for both "board" (does anyone know a good plumber / found
-- a lost cat) and "marketplace" (selling a sofa, splitting a bulk gas
-- delivery) posts, distinguished by `kind` - same author/property/
-- reply/moderation shape either way, no reason to duplicate it into
-- two tables and two sets of endpoints.
--
-- Scoped to property_id (a tenant's building), not landlord_id (a
-- landlord's whole portfolio) - a tenant should see their neighbors,
-- not every tenant the landlord has anywhere. Landlords who haven't
-- split their units into `properties` yet (pre-multi-property
-- accounts) fall back to a single implicit property per landlord,
-- same as the rest of the app already handles a null property_id.
--
-- Moderation mirrors the chat_messages soft-delete pattern
-- (deleted_at/deleted_by_role) rather than announcements' delete-scope
-- table, since there's no "hide for me only" requirement here - a
-- deleted post is just gone for everyone, same as a moderated chat
-- message.
-- =====================================================================

create table if not exists community_posts (
  id uuid primary key default gen_random_uuid(),

  -- Denormalized landlord_id alongside property_id, same reasoning as
  -- announcements.landlord_id: fast scoping/ownership checks without
  -- an extra join, and a stable anchor if a property is ever
  -- reassigned.
  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid references properties(id) on delete cascade,

  author_type text not null check (author_type in ('tenant', 'landlord', 'manager')),
  author_id uuid not null,

  kind text not null check (kind in ('board', 'marketplace')),
  title text,
  body text not null,
  price numeric,        -- marketplace only; null for board posts
  photo_url text,

  is_pinned boolean not null default false,

  deleted_at timestamptz,
  deleted_by_role text check (deleted_by_role in ('landlord', 'manager', 'tenant')),

  created_at timestamptz not null default now()
);

create index if not exists idx_community_posts_property
  on community_posts(landlord_id, property_id, is_pinned desc, created_at desc)
  where deleted_at is null;

create table if not exists community_post_replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references community_posts(id) on delete cascade,

  author_type text not null check (author_type in ('tenant', 'landlord', 'manager')),
  author_id uuid not null,
  body text not null,

  deleted_at timestamptz,
  deleted_by_role text check (deleted_by_role in ('landlord', 'manager', 'tenant')),

  created_at timestamptz not null default now()
);

create index if not exists idx_community_post_replies_post
  on community_post_replies(post_id, created_at asc)
  where deleted_at is null;

-- VERIFICATION:
--   select * from community_posts limit 1;
--   select * from community_post_replies limit 1;
-- =====================================================================


-- ============================================================
-- SECTION: 2026-07-scout-lead-pipeline.sql
-- ============================================================
-- =====================================================================
-- Scout lead pipeline visibility: "does anyone know a good plumber"
-- was community, this is the OTHER direct request - scout_referrals
-- currently only tracks a scout sharing a VACANT UNIT LISTING with a
-- landlord (shared -> viewed_by_landlord -> placed/expired, all
-- either automatic or landlord-triggered). There is no way for a
-- scout to show progress on an actual PROSPECTIVE TENANT they're
-- working - a scout who found someone, got them talking to the
-- landlord, and lined up a viewing has no way to show that effort
-- until the unit either gets rented (auto-credited, sometimes weeks
-- later) or doesn't. This adds:
--
--   1. Optional prospect_name/prospect_phone, captured when a scout
--      refers a unit, so a referral can represent an actual person,
--      not just an anonymous "someone might rent this."
--   2. Two new SELF-REPORTED stages a scout can advance through:
--      'contacted' and 'viewing_scheduled', sitting between 'shared'
--      and 'placed'. Deliberately scout-settable (not landlord- or
--      admin-gated) since chasing a landlord for confirmation on
--      every step of a lead's progress would defeat the "gives scouts
--      a reason to check back in" point of this - but 'placed' stays
--      exactly as it was: automatic-only, credited when the unit
--      actually goes occupied, never self-declared, so nobody can
--      claim a payout for a placement that didn't happen.
--
-- 'viewed_by_landlord' is kept as-is (a signal about the LANDLORD's
-- behavior, not the scout's) - it now sits alongside the scout's own
-- progress rather than gating it; see scout.controller.js
-- markReferralViewed for the updated (no-longer-'shared'-only) guard.
-- =====================================================================

alter table scout_referrals add column if not exists prospect_name text;
alter table scout_referrals add column if not exists prospect_phone text;
alter table scout_referrals add column if not exists stage_updated_at timestamptz;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'scout_referrals_status_check') then
    alter table scout_referrals drop constraint scout_referrals_status_check;
  end if;
end $$;

alter table scout_referrals
  add constraint scout_referrals_status_check
  check (status in ('shared', 'contacted', 'viewing_scheduled', 'viewed_by_landlord', 'placed', 'expired'));

-- VERIFICATION:
--   select column_name from information_schema.columns where table_name = 'scout_referrals' and column_name in ('prospect_name','prospect_phone','stage_updated_at');
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'scout_referrals_status_check';
-- =====================================================================


-- ============================================================
-- SECTION: add-tenant-reputation.sql
-- ============================================================
-- =====================================================================
-- Direct request: landlords can rate tenants, and that rating feeds
-- into a tenant reputation that is PORTABLE by email - it follows the
-- tenant to whichever landlord adds them next, the same way the
-- payment-reputation idea (see rentapay-notes) was meant to work.
--
-- Ratings are kept in their own table, one row per rating, rather than
-- a single mutable score on the tenant row, for the same reason
-- payments aren't collapsed into a running balance only: history
-- (who rated what, when, and why) has to survive archiving, restoring,
-- and the tenant moving to a completely different landlord.
--
-- Keyed by tenant_email (lowercased) as the durable cross-landlord
-- identity thread - matches the reasoning already used for phone
-- uniqueness in phoneUniqueness.js, but email is deliberately used
-- here instead of phone since that's the anchor the reputation idea
-- was built around (numbers get recycled, emails don't).
-- =====================================================================

create table if not exists tenant_ratings (
  id uuid primary key default gen_random_uuid(),

  -- Who rated, and about which tenant record at the time of rating.
  -- tenant_id is kept for traceability/display ("rated while at Unit
  -- X") but is NOT the aggregation key - a tenant can have several
  -- different tenant_id rows over their lifetime (one per landlord),
  -- and the rating has to keep counting even after that specific
  -- tenant_id is archived/deleted.
  landlord_id uuid not null references landlords(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete set null,
  unit_id uuid references units(id) on delete set null,

  -- Portable identity key. Always lowercased/trimmed on write.
  tenant_email text not null,
  tenant_phone text,
  tenant_name_at_rating text not null,

  rating int not null check (rating between 1 and 5),
  category text not null default 'overall' check (category in ('overall', 'payment', 'property_care', 'communication', 'conduct')),
  comment text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_tenant_ratings_email on tenant_ratings(tenant_email);
create index if not exists idx_tenant_ratings_landlord on tenant_ratings(landlord_id);
create index if not exists idx_tenant_ratings_tenant on tenant_ratings(tenant_id);

-- A landlord can update their own rating of a given tenant (by email)
-- rather than stacking a fresh row every time they re-rate the same
-- tenancy - one active "overall" rating per landlord+tenant email.
create unique index if not exists uq_tenant_rating_landlord_email_category
  on tenant_ratings(landlord_id, tenant_email, category);


-- ============================================================
-- SECTION: add-landlord-reputation.sql
-- ============================================================
-- =====================================================================
-- Mirror side of add-tenant-reputation.sql, same request thread:
-- tenants rating landlords. Kept aggregated-only by design (see
-- reputation notes) - "not a single visible review that exposes a
-- still-living-there tenant to retaliation, but enough to warn a
-- prospective tenant" about response times, deposit handling, etc.
-- So this table stores individual ratings (for averaging), but the
-- API never returns a single rating attributed to an identifiable
-- tenant back out - only the aggregate. See landlordReputation.service.js.
-- =====================================================================

create table if not exists landlord_ratings (
  id uuid primary key default gen_random_uuid(),

  landlord_id uuid not null references landlords(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete set null,

  rating int not null check (rating between 1 and 5),
  category text not null default 'overall' check (category in ('overall', 'maintenance_response', 'deposit_handling', 'communication')),
  comment text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_landlord_ratings_landlord on landlord_ratings(landlord_id);

-- One active rating per tenant+landlord+category - a tenant updating
-- their rating replaces it rather than stacking duplicates, same
-- pattern as tenant_ratings in add-tenant-reputation.sql.
create unique index if not exists uq_landlord_rating_tenant_category
  on landlord_ratings(tenant_id, landlord_id, category);


-- ============================================================
-- SECTION: 2026-07-charge-disputes.sql
-- ============================================================
-- =====================================================================
-- FEATURE (direct request: "dispute a charge - a lightweight 'this
-- doesn't look right' button on any line item that opens a chat
-- thread pre-filled with context"): today, if a tenant thinks a
-- payment row is wrong, their only path is to type up the whole
-- situation from scratch in the landlord_tenant chat (or worse, over
-- WhatsApp, invisible to RentaPay entirely) - the landlord has no
-- signal on the payment row itself that anything is contested.
--
-- This table is the persisted half of that feature: one row per
-- dispute, linked to the chat message it kicked off (see
-- dispute.controller.js, which posts a pre-filled context bubble into
-- the existing landlord_tenant thread AND writes this row so the
-- payment row can show a "Disputed" badge and the landlord has a
-- worklist instead of having to remember which chat threads had a
-- complaint buried in them).
--
-- Deliberately keyed as (payment_id, landlord_id, tenant_id) rather
-- than just payment_id alone, mirroring chat_messages' own shape, so
-- every other query in this feature (landlord's "my disputes" list,
-- tenant's own dispute status) can filter without a join back through
-- payments every time.
--
-- Scoped to payments for now ("any line item" in the request maps to
-- the payment history rows already on screen in both portals) - if
-- disputes are ever needed on another line-item type (an expense line,
-- a scout payout), add a nullable FK column for that type rather than
-- overloading payment_id, so existing rows/queries here are untouched.
-- =====================================================================

create table if not exists charge_disputes (
  id uuid primary key default gen_random_uuid(),

  payment_id uuid not null references payments(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,

  -- Whoever tapped "This doesn't look right" - in practice almost
  -- always the tenant, but a landlord/manager can also flag their own
  -- recorded entry as needing a second look (e.g. a manual payment
  -- they suspect was mis-keyed), so this isn't tenant-only.
  raised_by_role text not null check (raised_by_role in ('tenant', 'landlord', 'manager')),
  raised_by_id uuid not null,

  reason text, -- optional free-text the raiser typed before submitting

  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  resolved_by_role text check (resolved_by_role in ('landlord', 'manager', 'admin')),
  resolved_by_id uuid,
  resolution_note text,

  -- The chat bubble this dispute opened with, pre-filled with the
  -- payment's context (date/amount/method/status) plus the reason -
  -- lets the UI offer a "View conversation" link straight from the
  -- payment row without re-deriving which thread/message it was.
  chat_message_id uuid references chat_messages(id) on delete set null,

  created_at timestamptz not null default now()
);

-- One OPEN dispute per payment at a time - once resolved, a new one
-- can be raised (e.g. the same charge goes wrong again next month),
-- but you shouldn't be able to double-submit two open disputes on the
-- same line item and confuse the landlord's worklist.
create unique index if not exists uq_charge_disputes_open_payment
  on charge_disputes(payment_id)
  where status = 'open';

create index if not exists idx_charge_disputes_payment on charge_disputes(payment_id);
create index if not exists idx_charge_disputes_landlord_status on charge_disputes(landlord_id, status);
create index if not exists idx_charge_disputes_tenant on charge_disputes(tenant_id);


-- ============================================================
-- SECTION: 2026-07-payment-plan-requests.sql
-- ============================================================
-- =====================================================================
-- FEATURE (direct request: "in-app rent negotiation / payment plan
-- requests - tenant splits a payment, landlord approves/declines
-- in-app"): today a tenant who can't pay in full has to negotiate off
-- platform (call/text/WhatsApp) and the landlord has no record of what
-- was agreed. This gives a tenant a lightweight way to propose
-- splitting their current balance into installments, and gives the
-- landlord/manager a real approve/decline worklist for it - same
-- pattern as charge_disputes: a proposal row plus a plain-language
-- context message dropped into the same landlord_tenant chat thread,
-- so the negotiation and its outcome live in one place either side
-- already checks.
--
-- Deliberately NOT wired into the balance/payment engine itself
-- (approving a plan doesn't auto-split payments.amount_due or change
-- due_day_of_month) - it's a recorded agreement the landlord can point
-- back to, same as a dispute resolution note. Automatically enforcing
-- it is a natural next step once this is validated with real usage.
-- =====================================================================

create table if not exists payment_plan_requests (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null references tenants(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,

  total_amount numeric(12,2) not null,
  -- [{ "amount": 5000, "dueDate": "2026-08-05" }, ...] - tenant-proposed
  -- split; must sum to total_amount (enforced in the controller, not
  -- here, so a decent error message can be given rather than a raw DB
  -- constraint failure).
  installments jsonb not null default '[]'::jsonb,
  reason text,

  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  decision_note text,
  decided_at timestamptz,
  decided_by_role text check (decided_by_role in ('landlord', 'manager')),
  decided_by_id uuid,

  chat_message_id uuid references chat_messages(id) on delete set null,

  created_at timestamptz not null default now()
);

create index if not exists idx_payment_plan_requests_tenant on payment_plan_requests(tenant_id);
create index if not exists idx_payment_plan_requests_landlord_status on payment_plan_requests(landlord_id, status);

-- One open (pending) request per tenant at a time - mirrors the "one
-- open dispute per payment" rule in charge_disputes, for the same
-- reason: a second proposal while one's still awaiting a decision
-- would just fork the conversation.
create unique index if not exists uq_payment_plan_requests_one_pending_per_tenant
  on payment_plan_requests(tenant_id) where status = 'pending';


-- ============================================================
-- SECTION: 2026-07-scout-leaderboard-index.sql
-- ============================================================
-- =====================================================================
-- PERFORMANCE: supports the scout leaderboard's GET /scout/leaderboard
-- (scout.controller.js getLeaderboard), which aggregates
-- scout_referrals by scout_id filtered by status - a query shape none
-- of the existing scout_referrals indexes cover (they're all
-- unit_id/landlord_id-first). Without this, that query does a
-- sequential scan across every referral ever created as the table
-- grows, which is exactly the kind of thing that turns a "quick
-- leaderboard glance" into a multi-second load.
-- =====================================================================
create index if not exists idx_scout_referrals_scout_status on scout_referrals(scout_id, status);


-- ============================================================
-- SECTION: 2026-07-whatsapp-contact-numbers.sql
-- ============================================================
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


-- ============================================================
-- SECTION: 2026-07-trim-existing-emails.sql
-- ============================================================
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


-- ============================================================
-- SECTION: 2026-07-community-board-photos.sql
-- ============================================================
-- =====================================================================
-- Community board: support multiple photos per post (direct request:
-- "attach and post photos, not just text" + gallery/listing view).
-- Mirrors units.photo_urls - a plain array of Storage public URLs, up
-- to 5 per post. The original single-photo `photo_url` column is kept
-- as-is for backward compatibility with any existing rows/consumers;
-- it's populated with photo_urls[0] on new posts.
-- =====================================================================

alter table community_posts
  add column if not exists photo_urls text[];

-- VERIFICATION:
--   select id, photo_url, photo_urls from community_posts limit 1;
-- =====================================================================


-- ============================================================
-- SECTION: 2026-07-staff-ratings.sql
-- ============================================================
-- =====================================================================
-- Tenant -> Property Manager / Caretaker ratings (direct request #8:
-- "Tenants should be able to rate not just the Landlord, but also the
-- Property Manager and Caretaker separately - three distinct rating
-- categories"). Landlord ratings already exist (landlord_ratings,
-- see 2026-0x migration); this adds the missing manager/caretaker
-- side using the same 1-5 star + optional comment shape.
--
-- Keyed by manager_id (property_managers.id), NOT by email/phone like
-- tenant_ratings - property_managers.phone is already unique across
-- the whole table, so a given person can only ever have one
-- property_managers row on the platform. That row IS their durable
-- identity: it already follows them across every property they're
-- assigned to within their landlord account (the requirement that
-- "rating history follows them regardless of property/account
-- context" is satisfied automatically, no email-portability dance
-- needed the way tenant_ratings/landlord_ratings require).
--
-- role_level is denormalized from property_managers at rating time so
-- historical ratings stay correctly labeled even if a landlord later
-- changes someone from caretaker to full manager or vice versa.
-- =====================================================================

create table if not exists staff_ratings (
  id uuid primary key default gen_random_uuid(),

  landlord_id uuid not null references landlords(id) on delete cascade,
  manager_id uuid not null references property_managers(id) on delete cascade,
  role_level text not null check (role_level in ('manager', 'caretaker')),

  tenant_id uuid not null references tenants(id) on delete cascade,

  rating int not null check (rating between 1 and 5),
  comment text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One rating per tenant per staff member - re-rating updates the
  -- existing row (upsert), same convention as tenant_ratings/
  -- landlord_ratings' one-rating-per-relationship rule.
  unique (tenant_id, manager_id)
);

create index if not exists idx_staff_ratings_manager on staff_ratings(manager_id);

drop trigger if exists trg_staff_ratings_updated_at on staff_ratings;
create trigger trg_staff_ratings_updated_at before update on staff_ratings
  for each row execute function set_updated_at();

-- VERIFICATION:
--   select * from staff_ratings limit 1;
-- =====================================================================


-- ============================================================
-- SECTION: add-unit-public-listing-toggle.sql
-- ============================================================
-- ADD: units.is_publicly_listed
--
-- DIRECT REQUEST: "add an option in the landlord/manager portal that
-- they choose whether their vacant units should be listed public or
-- not." Previously every vacant unit automatically appeared on the
-- no-login /find-a-house public listings page with no way to opt
-- out - some landlords/managers want to fill a vacancy privately
-- (word of mouth, an existing waiting list, a specific agent) without
-- it being visible to anyone who opens that page.
--
-- Defaults to true so existing behavior (every vacant unit is public)
-- is unchanged for everyone until they explicitly flip it off.
alter table units add column if not exists is_publicly_listed boolean not null default true;

create index if not exists idx_units_public_listing on units(status, is_publicly_listed);


-- ============================================================
-- SECTION: 2026-07-remove-scout-role.sql
-- ============================================================
-- =====================================================================
-- REMOVE SCOUT ROLE - full teardown
--
-- The Scout role/portal has been removed from the app code and
-- replaced by the free "list units publicly" feature
-- (units.is_publicly_listed, see add-unit-public-listing-toggle.sql).
-- This migration undoes every schema change ever made across:
--   add-scout-role.sql
--   add-scout-help-and-announcements.sql
--   add-scout-password-reset-role.sql
--   add-scout-payments.sql
--   add-scout-profile-photo.sql
--   add-scout-push-notifications.sql
--   add-scout-referral-payouts.sql
--   add-scout-referrals.sql
--   2026-07-scout-exclusivity-and-constituency.sql (scout part only)
--   2026-07-scout-lead-pipeline.sql
--   2026-07-scout-leaderboard-index.sql
--
-- Run this ONCE in the Supabase SQL Editor. Order matters: tables that
-- reference scouts(id) are dropped/altered before scouts itself, and
-- every check constraint that was widened to include 'scout' is put
-- back to its pre-Scout list of allowed values.
--
-- units.last_verified_at is KEPT - it predates and is independent of
-- Scout (used by the ordinary "Still vacant - confirm" flow), even
-- though it was introduced in add-scout-referrals.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Drop Scout-only tables (children first).
-- ---------------------------------------------------------------------
drop index if exists idx_scout_referrals_scout_status;
drop table if exists scout_referrals cascade;
drop table if exists scout_county_payments cascade;
drop table if exists scout_manual_county_payments cascade;
drop table if exists scout_county_subscriptions cascade;
drop table if exists blocked_scouts cascade;
drop table if exists county_pricing_tiers cascade;
drop table if exists scouts cascade;

-- ---------------------------------------------------------------------
-- 2) chat_messages / chat_message_hidden - drop scout columns and put
--    every widened constraint back to its pre-Scout shape.
-- ---------------------------------------------------------------------
drop index if exists idx_chat_scout_landlord;

alter table chat_messages drop column if exists scout_id;
alter table chat_messages drop column if exists read_by_scout;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_thread_type_check') then
    alter table chat_messages drop constraint chat_messages_thread_type_check;
  end if;
end $$;
alter table chat_messages
  add constraint chat_messages_thread_type_check
  check (thread_type in ('admin_landlord', 'admin_tenant', 'landlord_tenant'));

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_thread_shape') then
    alter table chat_messages drop constraint chat_messages_thread_shape;
  end if;
end $$;
alter table chat_messages
  add constraint chat_messages_thread_shape check (
    (thread_type = 'admin_landlord'  and landlord_id is not null and tenant_id is null) or
    (thread_type = 'admin_tenant'    and tenant_id is not null) or
    (thread_type = 'landlord_tenant' and landlord_id is not null and tenant_id is not null)
  );

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_sender_role_check') then
    alter table chat_messages drop constraint chat_messages_sender_role_check;
  end if;
end $$;
alter table chat_messages
  add constraint chat_messages_sender_role_check
  check (sender_role in ('admin', 'landlord', 'manager', 'tenant'));

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_messages_deleted_by_role_check') then
    alter table chat_messages drop constraint chat_messages_deleted_by_role_check;
  end if;
end $$;
alter table chat_messages
  add constraint chat_messages_deleted_by_role_check
  check (deleted_by_role in ('admin', 'landlord', 'manager', 'tenant'));

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_message_hidden_viewer_role_check') then
    alter table chat_message_hidden drop constraint chat_message_hidden_viewer_role_check;
  end if;
end $$;
alter table chat_message_hidden
  add constraint chat_message_hidden_viewer_role_check
  check (viewer_role in ('admin', 'landlord', 'manager', 'tenant'));

-- ---------------------------------------------------------------------
-- 3) landlords - drop scout-visibility columns.
-- ---------------------------------------------------------------------
alter table landlords drop column if exists scout_visibility_enabled;
alter table landlords drop column if exists scout_disclosure_seen_at;

-- ---------------------------------------------------------------------
-- 4) help_requests / notifications / announcement_reads /
--    announcement_hidden / announcements - remove 'scout' from every
--    widened check constraint.
-- ---------------------------------------------------------------------
alter table help_requests drop constraint if exists help_requests_requester_type_check;
alter table help_requests add constraint help_requests_requester_type_check
  check (requester_type in ('landlord', 'tenant', 'guest'));

alter table notifications drop constraint if exists notifications_recipient_type_check;
alter table notifications add constraint notifications_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant'));

alter table announcement_reads drop constraint if exists announcement_reads_recipient_type_check;
alter table announcement_reads add constraint announcement_reads_recipient_type_check
  check (recipient_type in ('tenant', 'manager', 'landlord'));

alter table announcement_hidden drop constraint if exists announcement_hidden_recipient_type_check;
alter table announcement_hidden add constraint announcement_hidden_recipient_type_check
  check (recipient_type in ('tenant', 'manager', 'landlord'));

alter table announcements drop constraint if exists announcements_platform_target_group_check;
alter table announcements add constraint announcements_platform_target_group_check
  check (platform_target_group in ('all', 'tenants', 'landlord_team'));

-- ---------------------------------------------------------------------
-- 5) push_subscriptions - remove 'scout'.
-- ---------------------------------------------------------------------
alter table push_subscriptions drop constraint if exists push_subscriptions_recipient_type_check;
alter table push_subscriptions add constraint push_subscriptions_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant'));

-- ---------------------------------------------------------------------
-- 6) password_reset_requests - remove 'scout'.
-- ---------------------------------------------------------------------
alter table password_reset_requests drop constraint if exists password_reset_requests_role_check;
alter table password_reset_requests
  add constraint password_reset_requests_role_check
  check (role in ('landlord', 'tenant', 'manager', 'caretaker'));

-- =====================================================================
-- CLEANUP (optional, data hygiene only - safe to skip): any rows that
-- were left behind by a scout in the still-shared tables above have
-- already been made constraint-invalid by the changes above, so they
-- would only cause a problem if something tries to UPDATE them later
-- without also changing recipient_type/sender_role away from 'scout'.
-- Since inserts/updates of 'scout' rows are no longer possible after
-- this migration, and the app code no longer writes them, no further
-- action is required - existing historical 'scout' rows (if any) in
-- notifications/help_requests/announcement_reads etc. simply become
-- inert history. Delete them by hand only if you specifically want
-- them gone:
--
--   delete from notifications where recipient_type = 'scout';
--   delete from help_requests where requester_type = 'scout';
--   delete from announcement_reads where recipient_type = 'scout';
--   delete from announcement_hidden where recipient_type = 'scout';
-- =====================================================================

-- =====================================================================
-- VERIFICATION - run after the above and eyeball the output:
--
--   select table_name from information_schema.tables
--     where table_name in ('scouts','scout_county_subscriptions','county_pricing_tiers',
--                           'blocked_scouts','scout_referrals','scout_county_payments',
--                           'scout_manual_county_payments');
--   -- should return ZERO rows
--
--   select column_name from information_schema.columns
--     where table_name = 'landlords' and column_name in ('scout_visibility_enabled','scout_disclosure_seen_at');
--   -- should return ZERO rows
--
--   select column_name from information_schema.columns
--     where table_name = 'chat_messages' and column_name in ('scout_id','read_by_scout');
--   -- should return ZERO rows
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'chat_messages'::regclass and contype = 'c';
--   -- none of the definitions should mention 'scout'
-- =====================================================================


-- ============================================================
-- SECTION: 2026-07-property-reputation-listing-status-deposit.sql
-- ============================================================
-- =====================================================================
-- FEATURE (direct request): a PROPERTY reputation, separate from the
-- existing landlord / manager / caretaker reputations. Sits right
-- alongside those other rating widgets in the tenant portal ("beside
-- the existing reputations"), but with three deliberate differences:
--
--   1. It is rated by CURRENT TENANTS of that property (any active
--      tenant whose unit belongs to the property), not by one
--      tenant about one specific staff member.
--   2. It is the ONLY reputation ever shown on a PUBLIC page - the
--      vacant-units listing. Landlord/manager/caretaker reputations
--      stay exactly as they are today: visible only inside the
--      authenticated portals, never on the public listings page.
--   3. Like landlord/staff reputation, it is aggregate-only in any
--      response that could leak who-said-what about a place someone
--      still lives - never a single review tied to an identifiable
--      tenant.
--
-- Run this in the Supabase SQL Editor after schema.sql and
-- add-tenant-security-deposit.sql.
-- =====================================================================

create table if not exists property_ratings (
  id uuid primary key default gen_random_uuid(),

  property_id uuid not null references properties(id) on delete cascade,
  landlord_id uuid not null references landlords(id) on delete cascade,

  -- Kept for traceability ("rated while living in Unit X") but NOT the
  -- aggregation key, same reasoning as tenant_ratings.tenant_id - the
  -- rating must keep counting even after this specific tenant_id is
  -- archived/deleted, as long as the property itself still exists.
  tenant_id uuid references tenants(id) on delete set null,
  unit_id uuid references units(id) on delete set null,

  rating int not null check (rating between 1 and 5),
  category text not null default 'overall'
    check (category in ('overall', 'safety', 'maintenance', 'noise', 'water_electricity', 'value_for_money')),
  comment text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_property_ratings_property on property_ratings(property_id);
create index if not exists idx_property_ratings_landlord on property_ratings(landlord_id);
create index if not exists idx_property_ratings_tenant on property_ratings(tenant_id);

-- One active rating per tenant+property+category - a tenant updating
-- their rating replaces it rather than stacking duplicates, same
-- pattern as tenant_ratings/landlord_ratings/staff_ratings.
create unique index if not exists uq_property_rating_tenant_category
  on property_ratings(tenant_id, property_id, category);

-- =====================================================================
-- FEATURE (direct request): a landlord (or manager/caretaker) explicitly
-- confirms a vacant unit's listing status - "still active", "already
-- booked" (someone has committed but hasn't moved in/been marked
-- occupied yet), or "planned for" (earmarked, not really open to new
-- inquiries right now). This is DELIBERATELY separate from:
--   - units.status (occupied/notice_given/vacant/maintenance) - the
--     actual occupancy state, changed when a tenant is added/removed.
--   - units.last_verified_at - a simple "yes, still vacant" timestamp
--     ping (see add-scout-referrals.sql / "Still vacant - confirm").
--
-- listing_status only matters while units.status = 'vacant'; the
-- moment a tenant is filled in and units.status flips to 'occupied',
-- the unit already drops out of the public/vacant listing regardless
-- of listing_status (see public.controller.js's hard status='vacant'
-- filter) - so listing_status doesn't need its own cleanup on
-- occupancy, it simply stops being read.
-- =====================================================================

alter table units add column if not exists listing_status text not null default 'active'
  check (listing_status in ('active', 'booked', 'planned'));
alter table units add column if not exists listing_status_updated_at timestamptz;
alter table units add column if not exists listing_status_updated_by_type text
  check (listing_status_updated_by_type in ('landlord', 'manager', 'caretaker', 'admin'));

-- If this migration already ran before 'admin' was added to the list above,
-- widen the existing constraint so admin-confirmed status changes aren't
-- silently mislabeled as landlord-confirmed:
-- alter table units drop constraint if exists units_listing_status_updated_by_type_check;
-- alter table units add constraint units_listing_status_updated_by_type_check
--   check (listing_status_updated_by_type in ('landlord', 'manager', 'caretaker', 'admin'));
alter table units add column if not exists listing_status_updated_by_id uuid;

create index if not exists idx_units_listing_status on units(status, listing_status);

-- =====================================================================
-- FEATURE (direct request): show whether a unit requires a deposit at
-- all, in the vacant-unit listing - purely a landlord-set flag on the
-- UNIT itself (what's asked of any FUTURE tenant), distinct from
-- tenants.deposit_amount/deposit_status in add-tenant-security-deposit.sql
-- (what was actually collected from a tenant already living there).
-- Defaults to false so existing units read as "no deposit" until a
-- landlord explicitly says otherwise; deposit_amount_expected is
-- optional context (e.g. "1 month's rent") shown alongside the flag.
-- =====================================================================

alter table units add column if not exists requires_deposit boolean not null default false;
alter table units add column if not exists deposit_amount_expected numeric(12,2);

-- =====================================================================
-- VERIFICATION:
--   select table_name from information_schema.tables where table_name = 'property_ratings';
--   select column_name from information_schema.columns where table_name = 'units'
--     and column_name in ('listing_status','listing_status_updated_at','listing_status_updated_by_type',
--                          'listing_status_updated_by_id','requires_deposit','deposit_amount_expected');
-- =====================================================================


-- ============================================================
-- SECTION: add-rating-flag-for-review.sql
-- ============================================================
-- =====================================================================
-- DIRECT REQUEST: give a landlord recourse against a rating they
-- believe is in bad faith - e.g. one aggrieved tenant tanking a
-- property's score right before move-out, or the flip side people
-- worry about with any two-sided rating system, coached/traded ratings.
-- Nothing today lets a landlord do anything but sit with either.
--
-- Scope: this applies to the three rating tables where a TENANT rates
-- someone/something the landlord has a stake in - landlord_ratings,
-- staff_ratings, property_ratings. It deliberately does NOT apply to
-- tenant_ratings, since those are written BY the landlord about a
-- tenant - the landlord doesn't need a flag path for their own rating.
--
-- Design: this is a FLAG-FOR-REVIEW path, not a landlord-side delete/
-- override button. A landlord can mark a rating as disputed and say
-- why; while a flag is pending, that single rating is excluded from
-- the aggregate (so a live dispute doesn't keep counting against them
-- while under review) but the row itself is preserved - a landlord
-- can't just unilaterally erase an inconvenient rating. An admin (or
-- future review workflow) resolves the flag to either 'upheld' (rating
-- was legitimate, counts again) or 'removed' (confirmed bad-faith,
-- stays excluded). This mirrors how disputes.controller.js already
-- separates "raise a concern" from "unilaterally win it".
-- =====================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'landlord_ratings' and column_name = 'flag_status') then
    alter table landlord_ratings add column flag_status text not null default 'none'
      check (flag_status in ('none', 'flagged', 'upheld', 'removed'));
    alter table landlord_ratings add column flagged_by_landlord_id uuid references landlords(id) on delete set null;
    alter table landlord_ratings add column flag_reason text;
    alter table landlord_ratings add column flagged_at timestamptz;
    alter table landlord_ratings add column flag_resolved_at timestamptz;
    alter table landlord_ratings add column flag_resolution_note text;
  end if;

  if not exists (select 1 from information_schema.columns where table_name = 'staff_ratings' and column_name = 'flag_status') then
    alter table staff_ratings add column flag_status text not null default 'none'
      check (flag_status in ('none', 'flagged', 'upheld', 'removed'));
    alter table staff_ratings add column flagged_by_landlord_id uuid references landlords(id) on delete set null;
    alter table staff_ratings add column flag_reason text;
    alter table staff_ratings add column flagged_at timestamptz;
    alter table staff_ratings add column flag_resolved_at timestamptz;
    alter table staff_ratings add column flag_resolution_note text;
  end if;

  if not exists (select 1 from information_schema.columns where table_name = 'property_ratings' and column_name = 'flag_status') then
    alter table property_ratings add column flag_status text not null default 'none'
      check (flag_status in ('none', 'flagged', 'upheld', 'removed'));
    alter table property_ratings add column flagged_by_landlord_id uuid references landlords(id) on delete set null;
    alter table property_ratings add column flag_reason text;
    alter table property_ratings add column flagged_at timestamptz;
    alter table property_ratings add column flag_resolved_at timestamptz;
    alter table property_ratings add column flag_resolution_note text;
  end if;
end $$;

create index if not exists idx_landlord_ratings_flag_status on landlord_ratings(flag_status) where flag_status != 'none';
create index if not exists idx_staff_ratings_flag_status on staff_ratings(flag_status) where flag_status != 'none';
create index if not exists idx_property_ratings_flag_status on property_ratings(flag_status) where flag_status != 'none';


-- ============================================================
-- SECTION: 2026-07-tenant-rating-flag.sql
-- ============================================================
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


-- ============================================================
-- SECTION: 2026-07-tenant-rating-rater-role.sql
-- ============================================================
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


-- ============================================================
-- SECTION: 2026-07-normalize-existing-phone-numbers.sql
-- ============================================================
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


-- ============================================================
-- SECTION: 2026-07-landlord-email-verification.sql
-- ============================================================
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


-- ============================================================
-- SECTION: 2026-07-portfolio-digest.sql
-- ============================================================
-- =====================================================================
-- FEATURE (direct request #5 - portfolio health digest): a scheduled
-- summary email per landlord (occupancy rate, collection rate this
-- period, top late payers, vacant units with no photos). Defaults to
-- ON for everyone, with a single toggle to opt out, same convention as
-- notification_style above rather than a separate preferences table.
-- See src/jobs/portfolioDigest.job.js for what actually gets sent.
-- =====================================================================

alter table landlords add column if not exists portfolio_digest_enabled boolean not null default true;


-- ============================================================
-- SECTION: 2026-07-community-reads.sql
-- ============================================================
-- =====================================================================
-- Community board/marketplace: per-reader read-tracking, so the
-- sidebar "Community Board" nav item can show an unread-count badge
-- the same way Messages/Disputes/Payment Plan Requests already do.
-- Direct request: "no notification counter on community ui... in all
-- portals... i wish there is notification counters where messages are
-- involved."
--
-- Same shape/reasoning as announcement_reads (2026-07-announcements.sql):
-- one small join-table row per (post, reader) rather than an array
-- column on the post itself, so marking read is a cheap upsert that
-- never contends with other readers doing the same thing at once.
--
-- Run this in the Supabase SQL Editor.
-- =====================================================================

create table if not exists community_post_reads (
  post_id uuid not null references community_posts(id) on delete cascade,
  reader_type text not null check (reader_type in ('tenant', 'landlord', 'manager')),
  reader_id uuid not null,
  read_at timestamptz not null default now(),
  primary key (post_id, reader_type, reader_id)
);

create index if not exists idx_community_post_reads_reader on community_post_reads(reader_type, reader_id);


-- ============================================================
-- SECTION: add-unit-listing-description.sql
-- ============================================================
-- SEO (direct request: "richer listing page content" - real, unique
-- text per unit so Google has something to index/match search terms
-- against, and so schema.org Product descriptions on the public
-- listings page aren't just "location, constituency, county" repeated
-- for every card). Free-text, optional - a landlord/manager/caretaker
-- fills this in themselves (see updateListingDescription in
-- unit.controller.js) since only they actually know real details like
-- nearby landmarks, water reliability, security setup etc. Nullable:
-- existing units simply have no description until someone adds one,
-- and the public listings page/schema markup already handle a missing
-- description gracefully by falling back to location fields.
alter table units add column if not exists listing_description text;


-- ============================================================
-- SECTION: add-property-maps-link.sql
-- ============================================================
-- FEATURE (direct request): "when the landlord enters the location, it
-- should link with the map... such that it can be opened in maps and
-- viewed by those searching." Stores a plain Google Maps share link
-- (landlord opens Maps themselves, finds the spot, taps Share, pastes
-- the link here) rather than raw lat/lng - avoids needing a Google
-- Maps API key + billing account just to let a prospective tenant open
-- the exact location. A basic shape check (not a full URL validator)
-- happens in property.controller.js; storage here is deliberately
-- permissive text, same reasoning as location/description being plain
-- text rather than a stricter type.
alter table properties add column if not exists maps_link text;

-- property_payments holds the same form fields temporarily while an
-- M-Pesa payment is pending (see initiatePropertyPurchase /
-- completePropertyPurchase in property.controller.js) - needs the same
-- column so a maps link entered in the paid "add another property"
-- flow (AddPropertyModal.jsx) survives through to the final properties
-- row once payment completes, same as location/county/description do.
alter table property_payments add column if not exists maps_link text;


-- ============================================================
-- SECTION: 2026-07-fix-missing-columns.sql
-- ============================================================
-- =====================================================================
-- Migration: fix two columns missing from the live database
-- (2026-07-fix-missing-columns.sql)
-- =====================================================================
-- WHY THIS FILE EXISTS:
--
-- Both columns below are already defined in their original migration
-- files (add-unit-listing-description.sql, and community_post_replies
-- inside 2026-07-community-board.sql). But those tables already
-- existed on the live database BEFORE those columns were added to the
-- migration files - and `create table if not exists` is a no-op on a
-- table that already exists, so re-running the original files does
-- NOT retroactively add a missing column to an existing table. That's
-- exactly why these two errors were showing up in production logs:
--
--   [public] listVacantUnits error: column units.listing_description does not exist
--   [community] deleteReply error: Could not find the 'deleted_by_role' column of 'community_post_replies' in the schema cache
--
-- This file is a standalone, idempotent patch - safe to run any number
-- of times, and safe even if one or both columns already exist.
-- =====================================================================

alter table units
  add column if not exists listing_description text;

alter table community_post_replies
  add column if not exists deleted_by_role text
  check (deleted_by_role in ('landlord', 'manager', 'tenant'));

-- After running this, Supabase's PostgREST schema cache needs to
-- notice the new columns. It usually picks this up automatically
-- within a few seconds/minutes, but if the same errors persist right
-- after running this, force an immediate reload with:
--
--   select pg_notify('pgrst', 'reload schema');
--
-- (Supabase's SQL Editor -> "New query" -> run that single line -
-- this is the same signal Supabase's own dashboard "Reload schema
-- cache" button sends.)
select pg_notify('pgrst', 'reload schema');


-- ============================================================
-- SECTION: 2026-07-tenant-rating-reminders.sql
-- ============================================================
-- =====================================================================
-- Tenant rating reminder popups
-- DIRECT REQUEST: landlords/managers/caretakers get an occasional,
-- dismissible popup nudging them to rate a tenant that hasn't been
-- rated yet - either at random, or right after that tenant's payment
-- is confirmed. Nothing here changes existing rating data; it only
-- tracks *when to surface a nudge* to a given staff member.
-- Run in the Supabase SQL Editor after 2026-07-tenant-rating-rater-role.sql.
-- =====================================================================

create table if not exists tenant_rating_reminders (
  id uuid primary key default gen_random_uuid(),

  landlord_id uuid not null references landlords(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  property_id uuid references properties(id) on delete cascade,

  -- Who the nudge is for. rater_user_type is 'landlord' or
  -- 'property_manager' (covers both manager and caretaker logins,
  -- same convention as property_managers.role_level); rater_role
  -- mirrors tenant_ratings.rater_role for readability in the UI.
  rater_user_type text not null check (rater_user_type in ('landlord', 'property_manager')),
  rater_user_id uuid not null,
  rater_role text not null check (rater_role in ('landlord', 'manager', 'caretaker')),

  trigger_reason text not null default 'unrated' check (trigger_reason in ('unrated', 'payment')),

  snoozed_until timestamptz,
  dismissed_today_date date, -- "not today" - re-eligible once the date rolls over
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, rater_user_type, rater_user_id)
);

create index if not exists idx_rating_reminders_lookup
  on tenant_rating_reminders (rater_user_type, rater_user_id, snoozed_until);

create index if not exists idx_rating_reminders_tenant
  on tenant_rating_reminders (tenant_id);


-- ============================================================
-- SECTION: 2026-07-platform-reviews.sql
-- ============================================================
-- =====================================================================
-- Platform reviews - DIRECT REQUEST: a way for RentaPay to be
-- reviewed/rated by anyone, with or without an account, shown on our
-- own site (with schema.org markup so Google search results *can*
-- pick it up) and pointing people to also leave a review on our real
-- Google Business Profile / Facebook page.
-- Run in the Supabase SQL Editor.
-- =====================================================================

create table if not exists platform_reviews (
  id uuid primary key default gen_random_uuid(),

  -- Whoever is leaving the review. Anonymous visitors just give a
  -- display name; logged-in users are also linked by id/type so we
  -- can show "Verified landlord" etc. next to their review.
  display_name text not null,
  is_authenticated boolean not null default false,
  user_type text check (user_type in ('landlord', 'property_manager', 'tenant', null)),
  user_id uuid,

  rating int not null check (rating between 1 and 5),
  comment text,

  -- Basic spam/abuse control - reviews start visible immediately
  -- (direct request: no login needed, so no email-verification gate)
  -- but can be hidden by an admin without deleting the record.
  is_visible boolean not null default true,

  created_at timestamptz not null default now()
);

create index if not exists idx_platform_reviews_visible on platform_reviews (is_visible, created_at desc);


-- ============================================================
-- SECTION: 2026-07-onboarding-loop-and-archive-reuse-fix.sql
-- ============================================================
-- =====================================================================
-- Migration: onboarding loop bug (permanent fix) + archived
-- tenant/manager/caretaker phone reuse (permanent fix)
-- Run this once in the Supabase SQL Editor. Safe to re-run - every
-- statement is idempotent ("if not exists" / "if exists" guards).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ONBOARDING LOOP BUG (root cause)
-- ---------------------------------------------------------------------
-- setup_wizard_complete was only ever created inside schema.sql's
-- original "create table landlords" statement - unlike every other
-- schema change in this project, it never got an idempotent
-- "alter table ... add column if not exists" migration of its own.
-- Any database created before this column was added to schema.sql
-- simply does not have it. Without the column:
--   - completeSetupWizard() (auth.controller.js) fails on every call
--     (Supabase can't find the column to update)
--   - setup_wizard_complete never becomes true
--   - login()'s setupWizardComplete check is always false/undefined
--   - Login.jsx bounces the landlord back into RegisterFlow forever,
--     even though they already finished the wizard UI
-- This is the permanent fix: add the column the same idempotent way
-- must_change_password was added in 2026-07-fixes.sql.
alter table landlords add column if not exists setup_wizard_complete boolean default false;

-- ---------------------------------------------------------------------
-- 2. ARCHIVED MANAGER/CARETAKER PHONE REUSE (root cause)
-- ---------------------------------------------------------------------
-- property_managers.phone was created with a plain "unique" constraint
-- (schema.sql / 2026-07-property-managers.sql), scoped across ALL rows
-- regardless of is_active. That means once a landlord removes
-- (archives) a manager or caretaker, that phone number can NEVER be
-- reused for a new property_managers row again, anywhere on the
-- platform - even after the app-level checks in phoneUniqueness.js /
-- emailUniqueness.js were fixed to allow it, the INSERT itself would
-- still fail with a duplicate-key error at the database level.
--
-- Fix: drop the blanket unique constraint and replace it with a
-- partial unique index that only applies to ACTIVE rows - mirroring
-- how tenants (which have no such constraint at all) already allow an
-- archived person's phone to be reused under a new landlord.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'property_managers_phone_key'
  ) then
    alter table property_managers drop constraint property_managers_phone_key;
  end if;
end $$;

create unique index if not exists uq_property_managers_phone_active
  on property_managers (phone)
  where is_active = true;

-- Note: idx_property_managers_phone (a plain, non-unique index on
-- phone) already exists from 2026-07-property-managers.sql and still
-- covers lookup performance now that the unique constraint is gone -
-- no need to recreate it here.

