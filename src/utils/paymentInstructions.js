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
// Substitutes the {unit} token in an account-number TEMPLATE with
// this tenant's own unit label, so one saved value like "RENT-{unit}"
// works for every unit without the landlord touching it per-unit.
// A value with no {unit} token (a plain fixed account number) passes
// through untouched, so this is fully backward compatible.
// Direct request / bug report: a landlord typed a literal instruction
// into the account-number field itself - e.g. "888917#your room
// number" - meaning to tell the tenant to append their own room/unit
// number, the way you'd type it by hand into the M-Pesa app. Since
// the {unit} token already exists for exactly this ("RENT-{unit}"),
// but this landlord didn't know about it, every tenant was shown that
// raw instruction text verbatim instead of their actual unit - e.g.
// "888917#your room number" instead of "888917#GH03". The system
// already knows each tenant's own unit, so there's no need to make
// them type anything: detect this common instructional phrasing and
// substitute their real unit label automatically, same as {unit}
// does. A landlord who already uses {unit} is unaffected (checked
// first, in applyUnitTemplate).
const INSTRUCTIONAL_PHRASE_PATTERN = /(your|the)\s+(room|unit|house|door)\s+number/i;

function applyInstructionalPhraseFallback(value, unit) {
  if (!value || typeof value !== 'string') return value;
  if (!INSTRUCTIONAL_PHRASE_PATTERN.test(value)) return value;
  const unitLabel = (unit && (unit.unit_name || unit.unit_number)) || '';
  if (!unitLabel) return value; // nothing to substitute yet - leave as-is
  return value.replace(INSTRUCTIONAL_PHRASE_PATTERN, unitLabel);
}

function applyUnitTemplate(value, unit) {
  if (!value || typeof value !== 'string') return value;
  if (value.indexOf('{unit}') === -1) return applyInstructionalPhraseFallback(value, unit);
  const unitLabel = (unit && (unit.unit_name || unit.unit_number)) || '';
  return value.split('{unit}').join(unitLabel);
}

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
  const paybillAccountNumber = applyUnitTemplate(
    unitOverridden ? unit.payment_override_paybill_account_number
      : propertyOverridden ? resolvedProperty.payment_override_paybill_account_number
      : landlord.paybill_account_number,
    unit
  );
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
  // Direct request: a free-text note the landlord/manager writes once
  // at setup ("Rent is due by the 5th; water is billed separately"),
  // shown to the tenant right where they tap Pay Rent / Pay <utility>.
  // Same override precedence as everything else above.
  const description = unitOverridden ? unit.payment_override_description
    : propertyOverridden ? resolvedProperty.payment_override_description
    : landlord.payment_description;

  if (method === 'paybill' && paybillNumber) {
    return {
      method: 'paybill',
      paybillNumber,
      accountNumber: paybillAccountNumber || landlord.full_name || 'N/A',
      text: `Pay via M-Pesa Paybill ${paybillNumber}, Account Number: ${paybillAccountNumber || landlord.full_name}`,
      description: description || null,
      isOverride: overridden,
    };
  }

  if (method === 'till' && tillNumber) {
    return {
      method: 'till',
      tillNumber,
      text: `Pay via M-Pesa Buy Goods (Till Number) ${tillNumber}`,
      description: description || null,
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
    description: description || null,
    isOverride: overridden,
  };
}

module.exports = { buildPaymentInstructions };
