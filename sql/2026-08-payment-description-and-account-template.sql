-- Direct request: landlords/managers want to set up a payment
-- account-number ONCE using a template like "RENT-{unit}" so each
-- tenant automatically sees their own account number (e.g.
-- "RENT-A3") without the landlord manually creating a separate
-- paybill account number per unit. Also adds a free-text
-- "description" shown to the tenant when they tap Pay Rent / Pay
-- <utility> - e.g. "Rent is due on the 5th, water is billed
-- separately" - set once at the same level (account / apartment /
-- unit) as the rest of the payment method.
--
-- {unit} in any *paybill_account_number column is substituted at
-- read-time (see buildPaymentInstructions) with that tenant's own
-- unit_name/unit_number - it is never stored per-unit, so a landlord
-- with many units still only sets this up once.

alter table landlords add column if not exists payment_description text;
alter table properties add column if not exists payment_override_description text;
alter table units add column if not exists payment_override_description text;
