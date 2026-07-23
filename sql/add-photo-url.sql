-- =====================================================================
-- Migration: add photo_url to landlords and tenants
-- =====================================================================
-- Run once in Supabase SQL Editor. Stores a URL to a profile picture,
-- not the binary file itself - actual file upload/hosting (e.g. via
-- Supabase Storage) is a separate piece of work, scoped for later in
-- the same session this migration was requested in.

alter table landlords add column if not exists photo_url text;
alter table tenants add column if not exists photo_url text;
