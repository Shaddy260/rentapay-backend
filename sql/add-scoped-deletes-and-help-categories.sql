-- FIX (direct request): "when a landlord or caretaker or manager
-- confirms/rejects a payment, deleting it should only remove it from
-- their own view - it should not delete it out from under the other
-- two roles." pending_payment_confirmations previously had a single
-- shared row hard-deleted by DELETE /pending-confirmations/:id, so a
-- landlord deleting a confirmed record also erased it for every
-- manager/caretaker looking at the exact same landlord's list (and
-- vice versa). This adds one "hidden for this viewer type" flag per
-- viewer type instead of a real delete; the row is only ever
-- physically removed once every viewer type that can see it has
-- hidden it.
alter table pending_payment_confirmations
  add column if not exists hidden_for_landlord boolean not null default false,
  add column if not exists hidden_for_manager boolean not null default false,
  add column if not exists hidden_for_caretaker boolean not null default false;

-- FIX (direct request): help requests should be categorized by who
-- sent them (landlord / tenant / manager / caretaker / guest), not
-- just lumped together. requester_type already distinguishes
-- landlord/tenant/guest, but a property manager and a caretaker both
-- come through as backend role 'manager' - this captures the
-- sub-level so the admin portal can split them into their own tab.
alter table help_requests
  add column if not exists requester_role_level text;

-- FIX (direct request): "it should show also the phone number used to
-- send money - that should be entered by the tenants during
-- submission." Only the payer's NAME was ever captured, never the
-- phone the payment was actually sent from - which matters for
-- cross-checking against the real M-Pesa SMS when confirming.
alter table pending_payment_confirmations
  add column if not exists mpesa_payer_phone text;
