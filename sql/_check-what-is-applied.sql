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
  (select count(*) from information_schema.columns where table_name = 'units' and column_name = 'billing_period') as units_has_billing_period,
  -- Added after 2026-07-fix-missing-columns.sql: these two showed up
  -- as live production errors (listVacantUnits / deleteReply) because
  -- their tables already existed before the columns were added to the
  -- original migration files, so a plain re-run never applied them.
  (select count(*) from information_schema.columns where table_name = 'units' and column_name = 'listing_description') as units_has_listing_description,
  (select count(*) from information_schema.columns where table_name = 'community_post_replies' and column_name = 'deleted_by_role') as community_post_replies_has_deleted_by_role,
  -- Added after 2026-07-onboarding-loop-and-archive-reuse-fix.sql:
  -- 0 here means the onboarding-loop bug is still live on this
  -- database (setup_wizard_complete predates this check and only
  -- ever existed for databases created fresh from the latest
  -- schema.sql).
  (select count(*) from information_schema.columns where table_name = 'landlords' and column_name = 'setup_wizard_complete') as landlords_has_setup_wizard_complete,
  -- 1 here means the archived-manager/caretaker phone-reuse fix is
  -- applied (the old blanket unique constraint replaced with a
  -- partial index scoped to is_active = true). 0 means an archived
  -- manager/caretaker's phone still permanently blocks reuse.
  (select count(*) from pg_indexes where indexname = 'uq_property_managers_phone_active') as pm_has_active_scoped_phone_index;

-- Read the results: any column showing 0 means that migration (or part
-- of it) hasn't run yet on this database and you should run it.
-- has_notifications = 0 is EXPECTED right now - that's the one new
-- migration (2026-07-notifications-inbox.sql) you need to run for the
-- SMS+inbox feature to work.
