-- =====================================================================
-- Direct request: "in admin also should be notified on payment
-- submissions for scouts and landlords" + "notifications should look
-- native" (in-app bell + real OS push for admin too).
--
-- Root cause admin could never be notified in-app or via push: both
-- notifications.recipient_id and push_subscriptions.recipient_id are
-- `uuid` columns, but the admin account's id is the literal STRING
-- 'super-admin' (see auth.controller.js signToken({ id: 'super-admin',
-- role: 'admin' })) - not a real uuid. Any insert/query using that id
-- against a uuid column throws a Postgres type error, so it silently
-- failed everywhere it was tried.
--
-- Widening recipient_id to text is safe: existing uuid values still
-- compare/print identically as text, and every other recipient type
-- (landlord/manager/tenant/scout) keeps working exactly as before -
-- only the RANGE of accepted ids gets wider, not the query shape.
-- =====================================================================

alter table notifications alter column recipient_id type text using recipient_id::text;
alter table push_subscriptions alter column recipient_id type text using recipient_id::text;

alter table notifications drop constraint if exists notifications_recipient_type_check;
alter table notifications add constraint notifications_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant', 'scout', 'admin'));

alter table push_subscriptions drop constraint if exists push_subscriptions_recipient_type_check;
alter table push_subscriptions add constraint push_subscriptions_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant', 'scout', 'admin'));

-- VERIFICATION:
--   select data_type from information_schema.columns where table_name='notifications' and column_name='recipient_id'; -- should be 'text'
--   select data_type from information_schema.columns where table_name='push_subscriptions' and column_name='recipient_id'; -- should be 'text'
