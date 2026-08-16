-- ---------------------------------------------------------------------
-- RentaPay — General Manager Accounts (Sectioned Build Spec)
-- Section 7 — Automatic Logging & Admin Notification on Every Edit
-- Section 8 — Per-Manager Log Pages
-- Section 9 — Styled PDF Export of Logs
-- Section 10 — Admin Revert Capability
-- ---------------------------------------------------------------------
-- Distinct from the existing generic `activity_logs` table (which
-- already records a thin admin/GM/landlord/... audit trail across the
-- whole app - actor, action, target, IP). This new table is the
-- richer, GM-specific record the spec asks for: one row per
-- PIN-confirmed edit a General Manager makes, carrying everything
-- Section 7 requires (type of data edited, reason, affected role/
-- person, before/after state, extra context) plus what Sections 8-10
-- need to browse, export, and revert it later.
--
-- Written automatically, from inside logActivity() itself, whenever
-- actorType = 'general_manager' - see
-- src/services/activityLog.service.js and
-- src/services/generalManagerActivityLog.service.js. No controller
-- has to remember to call this directly (though several already pass
-- richer metadata in - before/after/affected-person-label - so this
-- table gets a genuinely readable record rather than bare IDs).
-- ---------------------------------------------------------------------

create table if not exists general_manager_activity_logs (
  id uuid primary key default gen_random_uuid(),

  general_manager_id uuid not null references general_managers(id) on delete cascade,

  -- Machine-readable action name, e.g. 'landlord_suspended',
  -- 'ba_reactivated', 'account_warned' - matches the `action` string
  -- already passed to logActivity() at the same call site.
  action text not null,
  -- Human-readable "type of data edited" shown on the log page,
  -- derived from `action` (e.g. "Landlord suspended") unless a
  -- friendlier label was supplied explicitly.
  data_type text not null,

  -- "Affected role (e.g. landlord, tenant, Brand Ambassador)"
  affected_role text,
  -- "Affected person (the specific individual/record involved)"
  affected_person_id text,
  affected_person_label text,

  -- "Initial data" / "Corrected-to data" - whatever shape the calling
  -- controller captured (a full row snapshot, or just the one or two
  -- fields that actually changed, e.g. { subscription_status: '...' }).
  initial_data jsonb,
  corrected_data jsonb,

  -- The mandatory reason typed by the General Manager (Section 6),
  -- copied in verbatim - this table's own copy, not a join, so a log
  -- entry stays complete even if something upstream ever changes.
  reason text not null,

  -- "Any other relevant context" - anything else the call site passed
  -- that didn't map to a field above (e.g. { days: 7 } for a
  -- temporary suspension).
  context jsonb,

  ip_address text,

  -- SECTION 10 — Admin Revert Capability. Whether this specific log
  -- entry is even eligible to be reverted (suspend/activate,
  -- financial edits, add/delete account, any account/entity status
  -- change - see REVERTIBLE_ACTIONS in
  -- generalManagerActivityLog.service.js), and, once acted on,
  -- whether/when/by-whom it actually was.
  is_revertible boolean not null default false,
  reverted_at timestamptz,
  reverted_by text, -- 'super-admin' (there is no separate admins table - see the same convention used by activity_logs / general_managers.created_by_admin)

  created_at timestamptz not null default now()
);

create index if not exists idx_gm_activity_logs_manager_created on general_manager_activity_logs (general_manager_id, created_at desc);
create index if not exists idx_gm_activity_logs_revertible on general_manager_activity_logs (general_manager_id, is_revertible, reverted_at);

-- Done when: every edit made under Section 6 reliably produces one
-- complete row here (Section 7), a General Manager's own rows can be
-- browsed and filtered by day/week/month (Section 8), exported as a
-- styled PDF for a date range (Section 9), and admin can revert them -
-- individually or in bulk, restoring the exact prior state captured
-- in initial_data (Section 10).
-- ---------------------------------------------------------------------
