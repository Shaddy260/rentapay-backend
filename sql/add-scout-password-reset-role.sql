-- =====================================================================
-- Fix: scout password-reset requests were silently failing to log to
-- the admin portal.
--
-- requestPasswordReset() in auth.controller.js has generically
-- supported accountType 'scout' since Phase 4/5 - a scout's OTP is
-- generated and sent correctly. But the write to
-- password_reset_requests (the table the admin portal reads to show
-- "recover this OTP if the SMS never arrived") was wrapped in a
-- try/catch that swallows errors as non-fatal - so every single scout
-- password-reset request has been hitting this table's
-- check (role in ('landlord','tenant','manager','caretaker')),
-- failing the constraint, being logged as a warning server-side, and
-- never showing up anywhere in the admin portal. The scout still gets
-- their SMS, so nothing was broken for the scout themself - only the
-- admin's ability to recover/resend if that SMS never arrived.
--
-- Run this in the Supabase SQL Editor AFTER schema.sql and
-- add-otp-expiry-and-password-reset-log.sql.
-- =====================================================================

alter table password_reset_requests drop constraint if exists password_reset_requests_role_check;

alter table password_reset_requests
  add constraint password_reset_requests_role_check
  check (role in ('landlord', 'tenant', 'manager', 'caretaker', 'scout'));
