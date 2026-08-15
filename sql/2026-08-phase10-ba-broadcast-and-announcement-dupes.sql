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

-- ---------------------------------------------------------------------
-- FIX (direct request: "shows two same messages...drop one"):
-- announcement.controller.js's fanOutAnnouncementPush used to call
-- notify() for every recipient, which ALWAYS wrote a second, separate
-- `notifications` row in addition to the `announcements` row that
-- already exists for the same broadcast. AnnouncementBell.jsx merges
-- both feeds into one list, so every announcement has been showing up
-- twice ever since that merge shipped. The application code is fixed
-- (notify() now accepts skipInbox: true, which the announcement
-- fan-out paths now pass) - this is the one-time cleanup for
-- duplicate rows that already exist from before that fix: every
-- `notifications` row with category='announcement' is redundant (that
-- category is ONLY ever written by the announcement fan-out paths,
-- nothing else uses it), since the real, user-facing record is the
-- matching `announcements` row, not this one.
-- ---------------------------------------------------------------------
delete from notifications where category = 'announcement';
