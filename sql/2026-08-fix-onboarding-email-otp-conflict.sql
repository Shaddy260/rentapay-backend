drop index if exists idx_onboarding_email_otps_link_email;
alter table tenant_onboarding_email_otps
  add constraint tenant_onboarding_email_otps_link_email_key
  unique (onboarding_link_id, email);
