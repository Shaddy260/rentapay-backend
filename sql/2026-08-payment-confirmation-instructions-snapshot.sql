-- Direct request / bug report: a landlord changed their Paybill
-- account number, and every PAST payment confirmation (including ones
-- from months ago, already confirmed) immediately started showing the
-- NEW account number / description instead of the one that was
-- actually in effect (and shown to the tenant) at the time they paid.
-- getPendingConfirmations was recomputing "Mode of payment" live via
-- buildPaymentInstructions on every read, using the landlord/unit/
-- property's CURRENT settings - so it silently rewrote history.
--
-- Fix: snapshot the resolved payment instructions once, at submission
-- time, onto the record itself. Old rows (submitted before this
-- migration) have no snapshot and keep falling back to the live
-- computation, same as before - only rows submitted after this ship
-- get the frozen, accurate account/description going forward.
alter table pending_payment_confirmations
  add column if not exists payment_instructions_snapshot jsonb;
