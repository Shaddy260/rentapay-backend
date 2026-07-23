-- =====================================================================
-- Direct request: "when notifications land in... they should not
-- land in silently... they should be default according to the user
-- profiles. if its vibrate they vibrate if ring they ring the users
-- notification tone."
--
-- Adds a stored preference so a push notification can ask the device
-- to vibrate vs. play the normal notification sound vs. stay fully
-- quiet, instead of every device just getting whatever it happened to
-- default to. See webpush.service.js for how this is read and turned
-- into the actual push payload, and Settings.jsx for where a landlord
-- picks their own.
--
-- Important, real limitation (documented here so it isn't
-- "discovered" as a bug later): the Web Push / Notification API lets
-- a site request vibration (a pattern) or ask for a fully silent
-- notification, but it can NOT choose or play a *custom ringtone* -
-- that decision belongs entirely to the phone's own OS/notification-
-- channel settings, the same as every other app's notifications. 
-- 'ring' here means "don't suppress sound - let the OS play its
-- normal notification sound", not "play a specific tone".
-- =====================================================================

alter table landlords add column if not exists notification_style text check (notification_style in ('ring', 'vibrate', 'silent')) default 'ring';
alter table tenants add column if not exists notification_style text check (notification_style in ('ring', 'vibrate', 'silent')) default 'ring';
alter table property_managers add column if not exists notification_style text check (notification_style in ('ring', 'vibrate', 'silent')) default 'ring';
