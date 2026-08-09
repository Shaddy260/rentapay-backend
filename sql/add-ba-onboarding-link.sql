-- =====================================================================
-- BRAND AMBASSADOR (BA) ROLE - ROTATING 24H ONBOARDING LINK
--
-- Replaces the old "always-live, never expires" /become-a-ba link.
-- There is still only ONE generic link (not per-person, not
-- per-invite) - but it now carries a token that expires 24h after
-- generation. Admin generates/regenerates it from the admin portal;
-- the previous token is immediately dead the moment a new one is
-- generated (see generateBaOnboardingLink - it doesn't wait for
-- expiry, regenerating early invalidates the old one right away too).
--
-- Every generation is inserted as a new row rather than updated
-- in-place, so there's a natural audit trail of who generated a link
-- and when. "The current link" is always just the most recent row.
-- =====================================================================

create table if not exists ba_onboarding_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  generated_by text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ba_onboarding_links_created_at on ba_onboarding_links (created_at desc);
create index if not exists idx_ba_onboarding_links_token on ba_onboarding_links (token);
