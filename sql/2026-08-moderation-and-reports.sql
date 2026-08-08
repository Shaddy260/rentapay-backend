-- =====================================================================
-- Account moderation (warn / temporarily suspend / permanently
-- suspend) + Community reports, across all four account types
-- (landlord, manager/caretaker, tenant - admin is not reportable).
-- =====================================================================

alter table landlords add column if not exists suspended_permanently boolean not null default false;
alter table landlords add column if not exists suspended_until timestamptz;
alter table landlords add column if not exists suspension_reason text;
alter table landlords add column if not exists warning_count int not null default 0;
alter table landlords add column if not exists report_count int not null default 0;

alter table property_managers add column if not exists suspended_permanently boolean not null default false;
alter table property_managers add column if not exists suspended_until timestamptz;
alter table property_managers add column if not exists suspension_reason text;
alter table property_managers add column if not exists warning_count int not null default 0;
alter table property_managers add column if not exists report_count int not null default 0;

alter table tenants add column if not exists suspended_permanently boolean not null default false;
alter table tenants add column if not exists suspended_until timestamptz;
alter table tenants add column if not exists suspension_reason text;
alter table tenants add column if not exists warning_count int not null default 0;
alter table tenants add column if not exists report_count int not null default 0;

-- Log of every warn/suspend/unsuspend action an admin takes, so the
-- admin "Reported accounts" screen can show warning/suspension
-- history per account, not just the current counters.
create table if not exists account_moderation_actions (
  id uuid primary key default gen_random_uuid(),
  account_type text not null check (account_type in ('landlord', 'manager', 'tenant')),
  account_id uuid not null,
  action text not null check (action in ('warned', 'suspended_permanent', 'suspended_temporary', 'unsuspended')),
  reason text,
  suspended_until timestamptz,
  admin_note text,
  created_at timestamptz default now()
);
create index if not exists idx_moderation_actions_account on account_moderation_actions(account_type, account_id);

-- Reports: a tenant/manager/landlord/caretaker flagging a community
-- post or reply. Scoped to landlord_id so the right
-- landlord/manager(s)/caretaker(s) get notified without a join.
create table if not exists community_reports (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid references properties(id) on delete set null,
  post_id uuid references community_posts(id) on delete set null,
  reply_id uuid references community_post_replies(id) on delete set null,

  reported_type text not null check (reported_type in ('landlord', 'manager', 'tenant')),
  reported_id uuid not null,
  reporter_type text not null check (reporter_type in ('landlord', 'manager', 'tenant')),
  reporter_id uuid not null,

  reason text not null,
  -- Snapshot of the reported content at the moment it was reported,
  -- so the report is still reviewable even if the post/reply is later
  -- edited or deleted by its author.
  content_snapshot text,
  photo_urls jsonb,

  status text not null check (status in ('open', 'warned', 'suspended', 'dismissed')) default 'open',
  created_at timestamptz default now(),
  reviewed_at timestamptz
);
create index if not exists idx_community_reports_landlord on community_reports(landlord_id);
create index if not exists idx_community_reports_reported on community_reports(reported_type, reported_id);
create index if not exists idx_community_reports_status on community_reports(status);

-- "Delete for me" (soft-hide, own view only) vs "delete for
-- everyone" (real delete, moderator-only) - see community.controller.js.
create table if not exists community_post_hidden (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references community_posts(id) on delete cascade,
  viewer_type text not null check (viewer_type in ('landlord', 'manager', 'tenant')),
  viewer_id uuid not null,
  created_at timestamptz default now()
);
create unique index if not exists idx_community_post_hidden_viewer on community_post_hidden(post_id, viewer_type, viewer_id);

create table if not exists community_reply_hidden (
  id uuid primary key default gen_random_uuid(),
  reply_id uuid not null references community_post_replies(id) on delete cascade,
  viewer_type text not null check (viewer_type in ('landlord', 'manager', 'tenant')),
  viewer_id uuid not null,
  created_at timestamptz default now()
);
create unique index if not exists idx_community_reply_hidden_viewer on community_reply_hidden(reply_id, viewer_type, viewer_id);
