// src/utils/paymentInstructions.js
//
// THE FIX for "don't tell tenants to use the unit code as the account
// number - show the landlord's own saved paybill/till + account
// number instead, everywhere payment info is shown or texted."
//
// Single source of truth for turning a landlord row's payment_method
// fields into (a) a human-readable instruction string for SMS/portal
// text, and (b) a structured object the frontend can render as a
// proper "Pay via Paybill" card. Every place that used to reach for
// unit.unit_payment_code as an "account number" should use this
// instead.

// `unit`, if given, may carry a per-unit override (payment_override_enabled
// + payment_override_method/paybill_number/paybill_account_number/
// till_number - see 2026-07-updates-v3.sql). `property`, if given, may
// carry the same shape of override at the apartment/property level
// (see 2026-07-property-payment-method.sql) - fixing the bug where a
// landlord with multiple apartments editing "the" payment method was
// really editing a single value shared by every apartment they own.
//
// Precedence, most specific wins: unit override > property override >
// landlord's own general/default payment method.
function buildPaymentInstructions(landlord, unit, property) {
  if (!landlord) return null;

  const resolvedProperty = property || (unit && unit.properties) || null;
  const unitOverridden = !!(unit && unit.payment_override_enabled);
  const propertyOverridden = !unitOverridden && !!(resolvedProperty && resolvedProperty.payment_override_enabled);
  const overridden = unitOverridden || propertyOverridden;

  const method = unitOverridden ? unit.payment_override_method
    : propertyOverridden ? resolvedProperty.payment_override_method
    : landlord.payment_method; // 'stk' | 'paybill' | 'till'
  const paybillNumber = unitOverridden ? unit.payment_override_paybill_number
    : propertyOverridden ? resolvedProperty.payment_override_paybill_number
    : landlord.paybill_number;
  const paybillAccountNumber = unitOverridden ? unit.payment_override_paybill_account_number
    : propertyOverridden ? resolvedProperty.payment_override_paybill_account_number
    : landlord.paybill_account_number;
  const tillNumber = unitOverridden ? unit.payment_override_till_number
    : propertyOverridden ? resolvedProperty.payment_override_till_number
    : landlord.till_number;
  // Direct request: "when a landlord sets payment method as STK push,
  // the landlord should also add the number - that number should be
  // displayed below the words STK push." Same override precedence as
  // everything else here.
  const stkPhoneNumber = unitOverridden ? unit.payment_override_stk_phone_number
    : propertyOverridden ? resolvedProperty.payment_override_stk_phone_number
    : landlord.stk_phone_number;

  if (method === 'paybill' && paybillNumber) {
    return {
      method: 'paybill',
      paybillNumber,
      accountNumber: paybillAccountNumber || landlord.full_name || 'N/A',
      text: `Pay via M-Pesa Paybill ${paybillNumber}, Account Number: ${paybillAccountNumber || landlord.full_name}`,
      isOverride: overridden,
    };
  }

  if (method === 'till' && tillNumber) {
    return {
      method: 'till',
      tillNumber,
      text: `Pay via M-Pesa Buy Goods (Till Number) ${tillNumber}`,
      isOverride: overridden,
    };
  }

  // Default / 'stk': tenant rent payment no longer auto-fires an STK
  // push prompt (removed per product decision - manual-only flow now,
  // same as paybill/till). This just tells the tenant which phone
  // number to send money TO via M-Pesa "Send Money", then they submit
  // proof the same way as every other method. (The landlord's own
  // SEPARATE subscription payment to the platform still uses a real
  // automated STK push via daraja.service.js - unrelated, untouched.)
  return {
    method: 'stk',
    stkPhoneNumber: stkPhoneNumber || null,
    text: stkPhoneNumber ? `Send payment via M-Pesa to ${stkPhoneNumber}.` : 'Contact your landlord for payment details.',
    isOverride: overridden,
  };
}

module.exports = { buildPaymentInstructions };
