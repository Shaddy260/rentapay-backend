// src/constants/platformPaybill.js
//
// RentaPay's OWN receiving Paybill/account for landlord subscription
// payments (the platform's revenue account - not any individual
// landlord's rent-collection Paybill). Used on the "didn't receive
// the STK popup? pay manually" fallback so a landlord/manager/
// caretaker always has a way to pay even when Daraja's push fails or
// is delayed.

const PLATFORM_PAYBILL_NUMBER = '522522';
const PLATFORM_PAYBILL_ACCOUNT_NUMBER = '1341657388';

module.exports = { PLATFORM_PAYBILL_NUMBER, PLATFORM_PAYBILL_ACCOUNT_NUMBER };
