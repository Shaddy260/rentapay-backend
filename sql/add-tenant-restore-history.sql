-- =====================================================================
-- Direct request: archived/deleted tenants need a proper restore flow
-- - pick which unit to restore them into (not automatic), and an
-- explicit yes/no on whether their payment history comes with them
-- (never automated). Payment history was already tied to tenant_id
-- (not unit_id) via the existing payments.tenant_id foreign key, so
-- restoring to a different unit was never going to lose history by
-- itself - what was actually missing was (a) a real
-- archived-tenants list to restore FROM, and (b) a way to start a
-- restored tenant on a clean slate when the landlord explicitly
-- chooses not to bring the old history along, without deleting that
-- history outright (it stays on record).
-- =====================================================================

-- When a restore explicitly excludes history, payments dated before
-- this timestamp are hidden from the TENANT's own "my payment
-- history" view (a fresh start) but remain fully visible to the
-- landlord/manager's payment history + the archive record - nothing
-- is actually deleted by an "exclude history" restore.
alter table tenants add column if not exists history_visible_from timestamptz;
