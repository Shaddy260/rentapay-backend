-- =====================================================================
-- Community board: support multiple photos per post (direct request:
-- "attach and post photos, not just text" + gallery/listing view).
-- Mirrors units.photo_urls - a plain array of Storage public URLs, up
-- to 5 per post. The original single-photo `photo_url` column is kept
-- as-is for backward compatibility with any existing rows/consumers;
-- it's populated with photo_urls[0] on new posts.
-- =====================================================================

alter table community_posts
  add column if not exists photo_urls text[];

-- VERIFICATION:
--   select id, photo_url, photo_urls from community_posts limit 1;
-- =====================================================================
