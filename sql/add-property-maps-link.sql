-- FEATURE (direct request): "when the landlord enters the location, it
-- should link with the map... such that it can be opened in maps and
-- viewed by those searching." Stores a plain Google Maps share link
-- (landlord opens Maps themselves, finds the spot, taps Share, pastes
-- the link here) rather than raw lat/lng - avoids needing a Google
-- Maps API key + billing account just to let a prospective tenant open
-- the exact location. A basic shape check (not a full URL validator)
-- happens in property.controller.js; storage here is deliberately
-- permissive text, same reasoning as location/description being plain
-- text rather than a stricter type.
alter table properties add column if not exists maps_link text;

-- property_payments holds the same form fields temporarily while an
-- M-Pesa payment is pending (see initiatePropertyPurchase /
-- completePropertyPurchase in property.controller.js) - needs the same
-- column so a maps link entered in the paid "add another property"
-- flow (AddPropertyModal.jsx) survives through to the final properties
-- row once payment completes, same as location/county/description do.
alter table property_payments add column if not exists maps_link text;
