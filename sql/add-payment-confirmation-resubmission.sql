-- =====================================================================
-- ADD: pending_payment_confirmations.resubmission_of
--
-- "When a tenant re-submits after a rejection, it should land in the
-- landlord's portal as a priority with a label - Resubmitted Request -
-- and appear at the top of all other requests regardless of when it
-- was sent." This links a new submission back to the rejected one it
-- replaces, so the UI can flag and prioritize it.
-- =====================================================================

alter table pending_payment_confirmations
  add column if not exists resubmission_of uuid references pending_payment_confirmations(id) on delete set null;

create index if not exists idx_pending_payment_confirmations_resubmission
  on pending_payment_confirmations(resubmission_of);
