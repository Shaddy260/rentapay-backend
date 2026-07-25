-- =====================================================================
-- Run this FIRST to see what's already in your database before
-- deciding which migrations you still need to run. Safe, read-only.
-- =====================================================================

select
  (select count(*) from information_schema.tables where table_name = 'properties') as has_properties,
  (select count(*) from information_schema.tables where table_name = 'property_managers') as has_property_managers,
  (select count(*) from information_schema.tables where table_name = 'property_manager_assignments') as has_pm_assignments,
  (select count(*) from information_schema.tables where table_name = 'rent_changes') as has_rent_changes,
  (select count(*) from information_schema.tables where table_name = 'property_payments') as has_property_payments,
  (select count(*) from information_schema.tables where table_name = 'chat_messages') as has_chat_messages,
  (select count(*) from information_schema.tables where table_name = 'help_requests') as has_help_requests,
  (select count(*) from information_schema.tables where table_name = 'notifications') as has_notifications, -- should be 0 until you run the new migration
  (select count(*) from information_schema.columns where table_name = 'landlords' and column_name = 'must_change_password') as landlords_has_must_change_password,
  (select count(*) from information_schema.columns where table_name = 'landlords' and column_name = 'payment_method') as landlords_has_payment_method,
  (select count(*) from information_schema.columns where table_name = 'property_managers' and column_name = 'role_level') as pm_has_role_level,
  (select count(*) from information_schema.columns where table_name = 'tenants' and column_name = 'paid_through_date') as tenants_has_paid_through_date,
  (select count(*) from information_schema.columns where table_name = 'units' and column_name = 'billing_period') as units_has_billing_period;

-- Read the results: any column showing 0 means that migration (or part
-- of it) hasn't run yet on this database and you should run it.
-- has_notifications = 0 is EXPECTED right now - that's the one new
-- migration (2026-07-notifications-inbox.sql) you need to run for the
-- SMS+inbox feature to work.
