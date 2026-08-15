-- FIX (direct request): admin's "Broadcast" composer has a "Send to"
-- option for "Brand ambassadors only" (see AdminDashboard.jsx, <option
-- value="ba">), and announcement.controller.js's
-- createPlatformAnnouncement already accepts targetGroup='ba' and
-- writes it to announcements.platform_target_group - but nothing ever
-- widened this column's CHECK constraint to actually allow the value
-- 'ba'. It was last set (2026-07-remove-scout-role.sql, when the
-- unrelated 'scouts' group was removed) to only allow
-- ('all', 'tenants', 'landlord_team'). Every attempt to send a
-- "Brand ambassadors only" broadcast has been failing the insert's
-- CHECK constraint ever since - surfaced in the admin UI as the generic
-- "Failed to send platform announcement." error, with no indication
-- of why. 'all' and 'landlord_team' broadcasts were unaffected (this
-- is additive - it only widens the constraint, doesn't touch the
-- existing allowed values), which is why this only showed up once
-- someone specifically tried the BA-only option.
alter table announcements drop constraint if exists announcements_platform_target_group_check;
alter table announcements add constraint announcements_platform_target_group_check
  check (platform_target_group in ('all', 'tenants', 'landlord_team', 'ba'));
