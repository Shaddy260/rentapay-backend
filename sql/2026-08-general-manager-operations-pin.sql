-- ---------------------------------------------------------------------
-- RentaPay — General Manager Accounts (Sectioned Build Spec)
-- Section 4 — Operations PIN Setup (Onboarding + Settings)
-- ---------------------------------------------------------------------
-- The Operations PIN is separate from the login password (Section 3)
-- and has a distinct job: confirming actions (Section 6), not logging
-- in. Stored hashed, same as password_hash - never in plaintext, and
-- never returned by any endpoint once set.
--
-- Reuses the same otp_code/otp_expires_at columns general_managers
-- doesn't have yet (unlike landlords/tenants/managers, this table was
-- only ever built for Section 2's minimal needs) - added here since
-- Section 4's forgot-PIN flow needs the exact same
-- generate-code/email/verify/expire shape as every other
-- forgot-password flow in this codebase (see auth.controller.js
-- requestPasswordReset/resetPassword), just gating a PIN reset instead
-- of a password reset.
-- ---------------------------------------------------------------------

alter table general_managers
  add column if not exists operations_pin_hash text,
  add column if not exists operations_pin_set_at timestamptz,
  -- Distinct from any password-reset OTP columns already used
  -- elsewhere by design - a General Manager could conceivably be
  -- mid password-change and mid PIN-reset at different times, and
  -- reusing a single otp_code column the way landlords/tenants do
  -- would let one flow silently invalidate the other's in-flight
  -- code. Kept as its own pair instead.
  add column if not exists pin_reset_otp text,
  add column if not exists pin_reset_otp_expires_at timestamptz;

-- Done when: a General Manager can set their Operations PIN during
-- onboarding, change it later from settings, and reset it via email
-- verification if forgotten - with no ability to skip setting one
-- (enforced at the application layer: every PIN-confirmed action in
-- Section 6 requires operations_pin_hash to be non-null before it can
-- even be attempted).
