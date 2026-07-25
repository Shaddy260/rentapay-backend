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
