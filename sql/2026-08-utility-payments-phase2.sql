-- 2026-08-utility-payments-phase2.sql
--
-- Phase 2: rent and utility balances become fully independent.
--   - payments.target_type / target_invoice_id: every payment row now
--     says whether it paid rent or a specific utility_invoices row.
--     Existing rows are untouched (they default to 'rent', which is
--     what they always were).
--   - pending_payment_confirmations gets the same two columns, so a
--     tenant can submit paybill proof against a specific water/
--     electricity bill instead of only ever against rent.
--   - utility bills stop touching tenants.balance_due entirely from
--     this point on (see finalizeRun in utilitySubmetering.controller.js)
--     - balance_due is rent-only from here forward.

alter table payments add column if not exists target_type text not null default 'rent' check (target_type in ('rent', 'utility'));
alter table payments add column if not exists target_invoice_id uuid references utility_invoices(id) on delete set null;
create index if not exists idx_payments_target_invoice on payments(target_invoice_id);

alter table pending_payment_confirmations add column if not exists target_type text not null default 'rent' check (target_type in ('rent', 'utility'));
alter table pending_payment_confirmations add column if not exists target_invoice_id uuid references utility_invoices(id) on delete set null;
create index if not exists idx_pending_confirmations_target_invoice on pending_payment_confirmations(target_invoice_id);
