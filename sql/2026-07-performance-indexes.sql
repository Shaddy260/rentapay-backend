-- Additive, safe to run any time - just an index, no schema/behavior change.
--
-- `payments` already had idx_payments_landlord(landlord_id) and
-- idx_payments_tenant(tenant_id) separately, but the dashboard's
-- "paid this month" figure and the annual report both filter by
-- landlord_id AND a paid_at date range together - neither existing
-- index serves that combined filter well.
create index if not exists idx_payments_landlord_paid_at on payments(landlord_id, paid_at);
