-- =====================================================================
-- Community board + marketplace: a tenant<->tenant space, scoped to
-- "everyone in this property". Separate from announcements
-- (landlord->tenant, one-way) and help/complaints (tenant->landlord,
-- private) - this is the first genuinely peer-to-peer surface in the
-- app.
--
-- One table for both "board" (does anyone know a good plumber / found
-- a lost cat) and "marketplace" (selling a sofa, splitting a bulk gas
-- delivery) posts, distinguished by `kind` - same author/property/
-- reply/moderation shape either way, no reason to duplicate it into
-- two tables and two sets of endpoints.
--
-- Scoped to property_id (a tenant's building), not landlord_id (a
-- landlord's whole portfolio) - a tenant should see their neighbors,
-- not every tenant the landlord has anywhere. Landlords who haven't
-- split their units into `properties` yet (pre-multi-property
-- accounts) fall back to a single implicit property per landlord,
-- same as the rest of the app already handles a null property_id.
--
-- Moderation mirrors the chat_messages soft-delete pattern
-- (deleted_at/deleted_by_role) rather than announcements' delete-scope
-- table, since there's no "hide for me only" requirement here - a
-- deleted post is just gone for everyone, same as a moderated chat
-- message.
-- =====================================================================

create table if not exists community_posts (
  id uuid primary key default gen_random_uuid(),

  -- Denormalized landlord_id alongside property_id, same reasoning as
  -- announcements.landlord_id: fast scoping/ownership checks without
  -- an extra join, and a stable anchor if a property is ever
  -- reassigned.
  landlord_id uuid not null references landlords(id) on delete cascade,
  property_id uuid references properties(id) on delete cascade,

  author_type text not null check (author_type in ('tenant', 'landlord', 'manager')),
  author_id uuid not null,

  kind text not null check (kind in ('board', 'marketplace')),
  title text,
  body text not null,
  price numeric,        -- marketplace only; null for board posts
  photo_url text,

  is_pinned boolean not null default false,

  deleted_at timestamptz,
  deleted_by_role text check (deleted_by_role in ('landlord', 'manager', 'tenant')),

  created_at timestamptz not null default now()
);

create index if not exists idx_community_posts_property
  on community_posts(landlord_id, property_id, is_pinned desc, created_at desc)
  where deleted_at is null;

create table if not exists community_post_replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references community_posts(id) on delete cascade,

  author_type text not null check (author_type in ('tenant', 'landlord', 'manager')),
  author_id uuid not null,
  body text not null,

  deleted_at timestamptz,
  deleted_by_role text check (deleted_by_role in ('landlord', 'manager', 'tenant')),

  created_at timestamptz not null default now()
);

create index if not exists idx_community_post_replies_post
  on community_post_replies(post_id, created_at asc)
  where deleted_at is null;

-- VERIFICATION:
--   select * from community_posts limit 1;
--   select * from community_post_replies limit 1;
-- =====================================================================
