-- =====================================================================
-- FEATURE (direct request #5 - portfolio health digest): a scheduled
-- summary email per landlord (occupancy rate, collection rate this
-- period, top late payers, vacant units with no photos). Defaults to
-- ON for everyone, with a single toggle to opt out, same convention as
-- notification_style above rather than a separate preferences table.
-- See src/jobs/portfolioDigest.job.js for what actually gets sent.
-- =====================================================================

alter table landlords add column if not exists portfolio_digest_enabled boolean not null default true;
