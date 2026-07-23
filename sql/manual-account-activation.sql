-- =====================================================================
-- Manual landlord activation - for development/testing only
-- =====================================================================
-- Use this when you've registered through the API (or want to seed a
-- test account directly) and need to skip the real M-Pesa + OTP flow.
--
-- IMPORTANT: login() in auth.controller.js does NOT check
-- subscription_status at all. The actual gates are:
--   1. is_verified must be true
--   2. password_hash must be a REAL bcrypt hash of the password you'll
--      type in - not the plaintext password itself
--   3. locked_until must be null or in the past
-- Setting subscription_status alone (as you were doing) does nothing
-- for login - that field only matters for dashboard/feature access
-- AFTER login already succeeds.
-- =====================================================================

-- STEP 1: Generate a real bcrypt hash for your test password.
-- Run this in your terminal (NOT in SQL) and copy the output:
--
--   node -e "require('bcrypt').hash('YourTestPassword123!', 12).then(h => console.log(h))"
--
-- It will print something like:
--   $2b$12$8K1p/a0dURXAm7QiTRqFe.YQT.fKLEx8FrcVDLg3kHZWlNxF3p7vS
--
-- That entire string is what goes in password_hash below - not your
-- plaintext password.

-- STEP 2: Run this, replacing the placeholders.
update landlords
set
  password_hash = '$2b$12$REPLACE_WITH_REAL_BCRYPT_HASH_FROM_STEP_1',
  is_verified = true,
  otp_code = null,
  otp_expires_at = null,
  failed_login_attempts = 0,
  locked_until = null,
  subscription_status = 'active',
  subscription_started_at = now(),
  subscription_expires_at = now() + interval '1 month',
  setup_wizard_complete = false  -- leave false so you can test the wizard; set true to skip it
where phone = '254712345678';   -- replace with the actual phone number

-- STEP 3 (optional): verify the row looks right before testing login.
select id, phone, is_verified, subscription_status, locked_until, failed_login_attempts,
       left(password_hash, 7) as hash_prefix  -- should print "$2b$12$" or similar
from landlords
where phone = '254712345678';

-- If hash_prefix does NOT start with $2a$, $2b$, or $2y$ followed by a
-- two-digit cost, the UPDATE above didn't take or you pasted the wrong
-- value - that's the exact condition scripts/diagnose-login.js checks
-- for automatically.

-- =====================================================================
-- Cleaning up an orphaned 'pending' record (the registration-crash
-- scenario) instead of trying to manually advance it:
-- =====================================================================
-- Generally simpler than activating a half-created row by hand - just
-- delete it and re-register through the API now that the orphan-record
-- bug in registerLandlord() is fixed (rolls back automatically on
-- failure going forward).
--
-- delete from landlords where phone = '254712345678' and subscription_status = 'pending';
