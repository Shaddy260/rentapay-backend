-- Utility meter deletion, made actually usable.
--
-- PROBLEM (direct request: "there should be a way for landlords or
-- managers to delete a meter"): a meter could only ever be deleted
-- while it had ZERO readings on file (see deleteMeter in
-- utilitySubmetering.controller.js). The instant a landlord submitted
-- even one reading - which is the whole point of adding a meter -
-- deleting it became permanently impossible, with only a small "why
-- can't I delete this" error to show for it. That's correct for
-- protecting billing history (past invoices reference those
-- readings), but it left no path at all for the very common real
-- case: "I set this meter up wrong / it's a duplicate / this unit
-- doesn't actually have separate metering, get rid of it."
--
-- FIX: meters with reading history are now ARCHIVED instead of
-- blocked outright - hidden from the active meter list (so they're
-- out of the way, same end result the landlord wants) while their
-- reading history stays intact underneath any invoices that already
-- reference it. A meter with NO readings is still hard-deleted, same
-- as before - nothing to preserve there.
alter table utility_meters add column if not exists is_archived boolean not null default false;
alter table utility_meters add column if not exists archived_at timestamptz;

create index if not exists idx_utility_meters_archived on utility_meters (landlord_id, is_archived);
