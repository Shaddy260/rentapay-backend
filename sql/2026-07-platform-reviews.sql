-- =====================================================================
-- Platform reviews - DIRECT REQUEST: a way for RentaPay to be
-- reviewed/rated by anyone, with or without an account, shown on our
-- own site (with schema.org markup so Google search results *can*
-- pick it up) and pointing people to also leave a review on our real
-- Google Business Profile / Facebook page.
-- Run in the Supabase SQL Editor.
-- =====================================================================

create table if not exists platform_reviews (
  id uuid primary key default gen_random_uuid(),

  -- Whoever is leaving the review. Anonymous visitors just give a
  -- display name; logged-in users are also linked by id/type so we
  -- can show "Verified landlord" etc. next to their review.
  display_name text not null,
  is_authenticated boolean not null default false,
  user_type text check (user_type in ('landlord', 'property_manager', 'tenant', null)),
  user_id uuid,

  rating int not null check (rating between 1 and 5),
  comment text,

  -- Basic spam/abuse control - reviews start visible immediately
  -- (direct request: no login needed, so no email-verification gate)
  -- but can be hidden by an admin without deleting the record.
  is_visible boolean not null default true,

  created_at timestamptz not null default now()
);

create index if not exists idx_platform_reviews_visible on platform_reviews (is_visible, created_at desc);
