-- =====================================================================
-- LANDLORD SIGNUP - PRE-ACCOUNT EMAIL VERIFICATION
--
-- DIRECT REQUEST: a landlord must verify their email on the SAME page
-- as their details, before continuing to payment - same pattern as
-- tenants confirm on the same page before submitting via the
-- onboarding link. Mirrors ba_email_otps / requestBaEmailVerification
-- exactly: keyed by the raw email string, not by a landlords row,
-- because no landlords row exists yet at the point someone is
-- verifying an email they might still change their mind about or
-- typo. This REPLACES the old post-registration email_otp_code /
-- email_otp_expires_at columns on landlords (added in
-- 2026-07-landlord-email-verification.sql) with a pre-registration
-- flow - verification now happens before the account row is ever
-- created, not after.
--
-- verification_token is set only once the code is confirmed correct -
-- registerLandlord requires the frontend to echo this exact value
-- back, proving the final submission is happening in the same
-- verified session rather than trusting a bare "verified = true" flag
-- that could be replayed against a different email typed later.
-- =====================================================================

create table if not exists landlord_registration_email_otps (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  otp_code text not null,
  expires_at timestamptz not null,
  verified boolean not null default false,
  verification_token text,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_landlord_registration_email_otps_email on landlord_registration_email_otps (lower(email));

create or replace function set_landlord_registration_email_otps_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_landlord_registration_email_otps_updated_at on landlord_registration_email_otps;
create trigger trg_landlord_registration_email_otps_updated_at
  before update on landlord_registration_email_otps
  for each row execute function set_landlord_registration_email_otps_updated_at();
