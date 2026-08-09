-- =====================================================================
-- BUILD SPEC PHASE 6 - BA Portal: Settings & Profile.
--
-- Mirrors add-scout-profile-photo.sql / add-scout-push-notifications.sql
-- for the brand_ambassador role:
--   1. brand_ambassadors.photo_url - so ProfilePhotoUpload.jsx's
--      shared upload/remove flow has somewhere to write for a BA,
--      same as landlords.photo_url / tenants.photo_url.
--   2. push_subscriptions.recipient_type widened to include
--      'brand_ambassador' - push.controller.js's recipientFor() now
--      routes a BA's own subscription there (see push.controller.js),
--      and Phase 10's qualification job will target this same
--      recipient type when a claim flips to qualified/paid.

alter table brand_ambassadors add column if not exists photo_url text;

alter table push_subscriptions drop constraint if exists push_subscriptions_recipient_type_check;
alter table push_subscriptions add constraint push_subscriptions_recipient_type_check
  check (recipient_type in ('landlord', 'manager', 'tenant', 'brand_ambassador'));
