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
