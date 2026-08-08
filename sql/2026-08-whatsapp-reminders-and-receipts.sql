-- =====================================================================
-- Section 5 (WhatsApp reminders) + Section 6 (upgraded payment receipts)
-- Run once against the existing database.
-- =====================================================================

-- Section 6: landlord KRA PIN / business registration number, shown on
-- the receipt PDF when the landlord has filled it in. Nullable/optional
-- - not every landlord has one on file.
alter table landlords add column if not exists kra_pin text;

-- Section 6: the rent period a payment covers (e.g. "August 2026"),
-- and a snapshot of the tenant's balance immediately after this
-- payment was applied. Both are set at the moment a payment completes
-- (STK callback / manual recording) and then printed on the receipt,
-- rather than recomputed later from the tenant's *current* balance,
-- which would drift as soon as another payment came in.
alter table payments add column if not exists rent_period text;
alter table payments add column if not exists balance_after numeric(12,2);

-- Section 5 note: WhatsApp reminders are a client-side wa.me deep link
-- built from data already on the tenants/units tables (phone, rent
-- amount, due day) - no new columns needed for that part.
