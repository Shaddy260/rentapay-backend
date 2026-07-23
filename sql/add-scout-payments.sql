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
