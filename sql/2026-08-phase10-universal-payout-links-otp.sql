-- =====================================================================
-- BUILD SPEC PHASE 10 (v2) - Universal BA Payout Links + Email/OTP Gate
--
-- Replaces the per-BA-token-in-URL scheme from
-- 2026-08-phase10-ba-payout-single-use-fix.sql with the design in the
-- "BA Payout Link System, Explained" plan:
--
--   1. Onboarding link - already universal + 24h (ba_onboarding_links,
--      untouched by this migration).
--   2. Submission link - now a single static URL
--      (/ba-payout-submit), the SAME for every BA, forever. Identity
--      is established at open-time via a registered-email + OTP gate,
--      not by a token embedded in the URL. Still exactly one
--      successful submission per BA, ever (enforced by
--      payout_submission_used_at + the existing unique index on
--      ba_payment_submissions.ba_id).
--   3. Edit/resubmission link - now a single rotating URL
--      (/ba-payout-edit?token=...), universal across every BA (any BA
--      needing a correction uses the same link), expiring 24h after
--      admin issues it - same "latest row wins" convention as
--      ba_onboarding_links. Also gated by email + OTP at open time.
--
-- No account-existence oracle: requesting an OTP always returns the
-- same generic response whether or not the email matches an eligible
-- BA - only sql/application logic below decides whether a code is
-- actually sent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Drop the old per-BA submission token - no longer part of the URL.
--    payout_submission_used_at stays: it's still the one-way lock that
--    permanently closes a BA's submission channel after their one
--    successful submission.
-- ---------------------------------------------------------------------
drop index if exists idx_brand_ambassadors_payout_submission_token;

alter table brand_ambassadors
  drop column if exists payout_submission_token,
  drop column if exists payout_submission_token_generated_at;

-- ---------------------------------------------------------------------
-- 2. ba_payout_edit_links: redesigned as a UNIVERSAL, rotating, 24h
--    link - identical convention to ba_onboarding_links. It is no
--    longer bound to a single ba_id up front; whichever BA verifies
--    their email + OTP against the currently-live token gets to edit
--    THEIR OWN on-file record only. "The current link" is always just
--    the most recently generated row (regenerating early kills the
--    previous one immediately, same as onboarding).
-- ---------------------------------------------------------------------
drop table if exists ba_payout_edit_links;

create table ba_payout_edit_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  generated_by text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index idx_ba_payout_edit_links_created_at on ba_payout_edit_links (created_at desc);
create index idx_ba_payout_edit_links_token on ba_payout_edit_links (token);

-- ---------------------------------------------------------------------
-- 3. ba_payout_link_otps: the email + OTP identity gate shared by both
--    the submission link and the edit link. Keyed by (email, purpose)
--    so a BA can have at most one live code per purpose at a time -
--    requesting a new one simply overwrites (upserts) the old one,
--    same convention as ba_email_otps.
--
--    purpose = 'submit' -> gates the one-time submission link.
--    purpose = 'edit'   -> gates the current edit link; edit_link_token
--                          pins the OTP session to the specific edit
--                          link token it was requested against, so a
--                          verified code can't be replayed once admin
--                          regenerates the edit link.
--
--    consumed_at is stamped the moment the verification_token this OTP
--    produced is actually used to submit/edit - a verified-but-unused
--    OTP session can't be used twice.
-- ---------------------------------------------------------------------
create table if not exists ba_payout_link_otps (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  purpose text not null check (purpose in ('submit', 'edit')),
  edit_link_token text,
  otp_code text not null,
  expires_at timestamptz not null,
  verified boolean not null default false,
  verification_token text,
  verification_expires_at timestamptz,
  consumed_at timestamptz,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ba_payout_link_otps_email_purpose_uidx
  on ba_payout_link_otps (lower(email), purpose);
create index if not exists idx_ba_payout_link_otps_verification_token
  on ba_payout_link_otps (verification_token);

create or replace function set_ba_payout_link_otps_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_ba_payout_link_otps_updated_at on ba_payout_link_otps;
create trigger trg_ba_payout_link_otps_updated_at
  before update on ba_payout_link_otps
  for each row execute function set_ba_payout_link_otps_updated_at();

-- =====================================================================
-- End of Phase 10 (v2) migration.
-- =====================================================================
