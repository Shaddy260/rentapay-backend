-- =====================================================================
-- GENERAL MANAGER ROLE - SELF-SERVICE ONBOARDING LINK
--
-- Mirrors add-ba-onboarding-link.sql / add-brand-ambassador-email-otps.sql.
-- Replaces admin manually typing in a General Manager's details: admin
-- generates one link (24h TTL, regenerating early kills the previous
-- token immediately) and sends it privately to the specific person
-- they're inviting. That person fills in their own full name, ID
-- number, email (verified via a one-time code before submission),
-- phone, and gender - same self-fill + email-proof pattern as BA
-- onboarding, just without a pending-approval queue, since admin
-- already chose this exact person by generating and sending the link.
-- =====================================================================

create table if not exists gm_onboarding_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  generated_by text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gm_onboarding_links_created_at on gm_onboarding_links (created_at desc);
create index if not exists idx_gm_onboarding_links_token on gm_onboarding_links (token);

create table if not exists gm_email_otps (
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

create index if not exists idx_gm_email_otps_email on gm_email_otps (lower(email));

create or replace function set_gm_email_otps_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_gm_email_otps_updated_at on gm_email_otps;
create trigger trg_gm_email_otps_updated_at
  before update on gm_email_otps
  for each row execute function set_gm_email_otps_updated_at();

-- National ID is now collected at onboarding (Prompt 7) - wasn't
-- required back when admin typed in GM accounts by hand.
alter table general_managers add column if not exists national_id text;
