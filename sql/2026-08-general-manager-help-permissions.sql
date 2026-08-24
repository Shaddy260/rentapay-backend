-- =====================================================================
-- GENERAL MANAGER ROLE - HELP REQUESTS & HELP/CONTACT DETAILS TOGGLES
--
-- FEATURE (direct request): every General Manager can already SEE the
-- tenant-facing "Help requests" queue and the "Help & Contact
-- Details" screen (support email, call numbers, WhatsApp numbers) -
-- purely so they can notice something needs attention and nudge admin
-- if it's been sitting too long, same "visibility isn't the mandate
-- to act" split can_manage_manual_payments already uses. These two
-- new columns gate the ACTIONS only:
--   1. can_manage_help_requests   - resolve/delete a help request, and
--      read its reply thread.
--   2. can_manage_help_contacts   - edit the support email, and
--      add/edit/delete call & WhatsApp numbers.
--
-- Both default false, so running this migration does not silently
-- grant either capability to any existing General Manager account -
-- admin has to explicitly switch each one on per manager, same as
-- every other GM permission toggle.
-- =====================================================================

alter table general_managers add column if not exists can_manage_help_requests boolean not null default false;
alter table general_managers add column if not exists can_manage_help_contacts boolean not null default false;

-- Done when: GeneralManagersPanel.jsx's roster has a toggle for each
-- of these per manager, the help-request resolve/delete/reply-thread
-- endpoints and the help-contacts write endpoints check the matching
-- flag for a general_manager caller (admin is never gated), and the
-- General Manager's dashboard only renders the write controls (not
-- the view itself, which always shows) when the flag is on.
