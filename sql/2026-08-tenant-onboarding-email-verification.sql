create table if not exists tenant_onboarding_email_otps (
  id uuid primary key default gen_random_uuid(),
  onboarding_link_id uuid not null references tenant_onboarding_links(id) on delete cascade,
  email text not null,
  otp_code text not null,
  expires_at timestamptz not null,
  verified boolean not null default false,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_onboarding_email_otps_link_email
  on tenant_onboarding_email_otps(onboarding_link_id, lower(email));

drop trigger if exists trg_onboarding_email_otps_updated_at on tenant_onboarding_email_otps;
create trigger trg_onboarding_email_otps_updated_at before update on tenant_onboarding_email_otps
  for each row execute function set_updated_at();
