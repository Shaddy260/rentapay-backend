-- =====================================================================
-- FIX (Prompt 1): BA payout-link OTP requests silently failing for
-- valid, active accounts on both the submission and correction flows.
--
-- Root cause: 2026-08-phase10-universal-payout-links-otp.sql created a
-- FUNCTIONAL unique index on (lower(email), purpose), but
-- baPayoutSubmissionLink.service.js's requestOtp() upserts with
-- { onConflict: 'email,purpose' } - which targets the literal `email`
-- column, not the lower(email) expression. Postgres rejects any
-- ON CONFLICT clause that doesn't exactly match an existing
-- unique/exclusion constraint, so every request-OTP upsert threw
-- before ever reaching the sendEmail() call - no code was ever sent,
-- for anyone, regardless of whether their account was active.
--
-- Fix: replace the functional index with a plain unique constraint on
-- the literal (email, purpose) columns, which is safe because the
-- application code already lowercases the email before every insert/
-- upsert into this table (see normalizedEmail in requestOtp/verifyOtp).
-- =====================================================================

drop index if exists ba_payout_link_otps_email_purpose_uidx;

alter table ba_payout_link_otps
  add constraint ba_payout_link_otps_email_purpose_key unique (email, purpose);
