-- =====================================================================
-- BRAND AMBASSADOR (BA) ROLE - PHASE 2: EMAIL OTP FOR SELF-ONBOARDING
--
-- Backs requestBaEmailVerification / confirmBaEmailVerification in
-- brandAmbassador.controller.js. Deliberately keyed by the raw email
-- string, not by a brand_ambassadors row - a prospective BA hasn't
-- submitted anything yet at the point they're verifying their email
-- (see Phase 2 build spec: "Do NOT create a brand_ambassadors row yet
-- at this step"), so there's no account row to attach this to.
--
-- verification_token is set only once the code is confirmed correct -
-- submitBaOnboarding requires the frontend to echo this exact value
-- back, proving the final submission is happening in the same
-- verified session rather than trusting a bare "verified = true" flag
-- that could be replayed against a different email typed later.
-- =====================================================================

create table if not exists ba_email_otps (
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

create index if not exists idx_ba_email_otps_email on ba_email_otps (lower(email));

-- Keep updated_at honest on upsert, same convention used elsewhere in
-- this codebase for hand-rolled "touch" triggers.
create or replace function set_ba_email_otps_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_ba_email_otps_updated_at on ba_email_otps;
create trigger trg_ba_email_otps_updated_at
  before update on ba_email_otps
  for each row execute function set_ba_email_otps_updated_at();
