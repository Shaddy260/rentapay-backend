-- =====================================================================
-- Adds a "role_level" to property_managers so a landlord can add
-- someone as either a full Property Manager or a more limited
-- Caretaker, without needing a whole separate account table - they
-- still log in as "manager" underneath, just with fewer permissions
-- when role_level = 'caretaker'.
--
-- Caretakers can: view properties/tenants they're assigned to, remind
-- tenants, send bulk reminders, revoke a vacating notice.
-- Caretakers cannot: delete a tenant, waive interest, transfer a
-- tenant between units, add/remove units, or add extra charges.
-- (Adding/removing properties, managers, and subscription/billing
-- were already landlord-only before this and are unaffected.)
-- =====================================================================

alter table property_managers add column if not exists role_level text not null default 'manager'
  check (role_level in ('manager', 'caretaker'));
