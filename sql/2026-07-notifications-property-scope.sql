-- =====================================================================
-- Direct request: "every apartment be solely independent... not
-- sharing anything across any apartments... even notifications...
-- nothing should leak."
--
-- notifications was keyed only by (recipient_type, recipient_id) - for
-- a landlord that recipient_id is their ONE account, so every
-- notification about every property they own (rent reminders,
-- payment receipts, maintenance reports, tenant messages...) landed
-- in the exact same inbox with no way to tell them apart, let alone
-- filter the inbox down to just the apartment currently selected in
-- the property switcher.
--
-- Adding property_id lets notify() tag a notification with whichever
-- property it's actually about (see notify.service.js), and lets
-- listNotifications (notifications.controller.js) filter the inbox to
-- just the active property - genuinely account-wide notices (a
-- password change, a new manager added, a subscription-wide notice on
-- the landlord's own original/pooled property) keep property_id null
-- and still show up regardless of which apartment is selected, same
-- as the shared phone number/profile.
-- =====================================================================

alter table notifications add column if not exists property_id uuid references properties(id) on delete set null;

create index if not exists idx_notifications_recipient_property on notifications(recipient_type, recipient_id, property_id, created_at desc);
