-- =====================================================================
-- Direct request: shorten OTP/credential expiry windows.
--   - First-time login details (temp password + OTP handed to a new
--     tenant/manager/caretaker/scout): 3 days -> 24 hours.
--   - Password-reset codes: now 5 minutes (previously shared the same
--     3-day window as everything else - see auth.controller.js /
--     utils/otp.js for the application-level change; this migration
--     just brings the DB-level default on first_time_credentials in
--     line with the new 24h app-level value, since the app now always
--     sets expires_at explicitly on insert anyway).
-- =====================================================================

alter table first_time_credentials
  alter column expires_at set default (now() + interval '24 hours');

-- Existing rows created under the old 14-day default are left as-is
-- (already-issued codes keep whatever expiry they were promised) -
-- only new rows going forward use the shorter window.
