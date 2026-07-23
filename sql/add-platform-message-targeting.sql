-- Direct request: "in the admin portal under messages, there should
-- be options as to whom to send the message to - all, tenants only,
-- or landlords/managers/caretakers only (as these three share a
-- common dashboard)." Platform-wide announcements previously always
-- reached literally everyone with no way to narrow it.
alter table announcements add column if not exists platform_target_group text
  check (platform_target_group in ('all', 'tenants', 'landlord_team'));
-- Existing rows (sent before this column existed) default to 'all' in
-- application code when this is null, so nothing already sent
-- suddenly stops reaching people it used to reach.
