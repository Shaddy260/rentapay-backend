-- Item 6: Manual BA claim matching is too loose.
--
-- submitLandlordClaim (src/controllers/brandAmbassador.controller.js)
-- now rejects a manually-logged claim whenever any field the BA
-- provided (name, email, location) disagrees with the landlord record
-- found by phone, instead of silently matching on a single correct
-- field. Rejected attempts are still written to ba_landlord_claims for
-- audit purposes (same pattern as the existing 'conflict' status), so
-- the match_status check constraint needs a new 'mismatch' value.

alter table ba_landlord_claims drop constraint if exists ba_landlord_claims_match_status_check;
alter table ba_landlord_claims add constraint ba_landlord_claims_match_status_check
  check (match_status in ('unmatched', 'matched', 'conflict', 'mismatch'));
