-- ---------------------------------------------------------------------
-- RentaPay — General Manager Accounts
-- Forgot Password (direct request: "general manager dont have a way
-- to reset their password ... add it and also add it from the login
-- screen")
-- ---------------------------------------------------------------------
-- general_managers already has password_hash / must_change_password
-- (see 2026-08-general-manager-role.sql) but never gained the
-- otp_code / otp_expires_at pair every other login-capable table
-- (landlords, tenants, property_managers) uses for its forgot-
-- password flow - because a General Manager's own login was built as
-- a single dedicated endpoint (generalManagerLogin) rather than going
-- through the shared multi-account-type login(), forgot-password
-- never got wired up alongside it. Adding the same two columns here
-- lets generalManagerForgotPassword/generalManagerResetPassword in
-- auth.controller.js reuse the exact same OTP mechanics, self-
-- contained to this one table (see accountTable()'s existing
-- 'general_manager' → general_managers mapping).
-- ---------------------------------------------------------------------

alter table general_managers
  add column if not exists otp_code text,
  add column if not exists otp_expires_at timestamptz;

-- Done when: a General Manager who forgot their password can request
-- a reset code to their registered email straight from the "General
-- Manager login" screen (no separate URL to find), submit code + new
-- password, and log back in - identical mechanics to every other
-- role's forgot-password flow, just scoped to this one table.
-- ---------------------------------------------------------------------
