// src/utils/prepayment.js
//
// REWRITTEN: the previous version tracked "paid ahead" via a separate
// paid_through_date column that was updated independently from
// balance_due. That created two parallel sources of truth for the
// same thing (how much is this tenant ahead/behind?) that could and
// did drift out of sync - e.g. a payment path that updated one but
// not the other, or updated balance_due incorrectly while leaving
// paid_through_date untouched. That mismatch is what caused balances
// to look "stuck" after a payment was recorded.
//
// New model: balance_due is the ONLY source of truth, a single
// running ledger number:
//   balance_due > 0  -> tenant owes this much right now (shown in red)
//   balance_due == 0 -> settled, nothing owed, nothing ahead
//   balance_due < 0  -> tenant has a credit of abs(balance_due); this
//                       many KES have already been paid toward future
//                       rent. Everything else (days ahead, projected
//                       next due date) is DERIVED from this number on
//                       the fly, never stored separately, so it can
//                       never go out of sync with the money.

/**
 * Applies a payment directly to the ledger. This is the only place
 * balance_due should ever be modified by a payment (STK, manual, or
 * paybill) - no separate "is this a partial or overpayment" branching
 * against the transaction's own requested amount (that was the root
 * bug: comparing a payment to itself instead of to what was actually
 * owed). Positive result = still owed. Negative result = credit.
 *
 * @param {number} currentBalance - tenant.balance_due before this payment
 * @param {number} amountPaid
 * @returns {number} new balance_due, rounded to 2dp
 */
function applyPaymentToBalance(currentBalance, amountPaid) {
  const result = Number(currentBalance || 0) - Number(amountPaid || 0);
  return Math.round(result * 100) / 100;
}

/**
 * Builds the "you're paid ahead" summary shown in the tenant/landlord
 * portals, derived purely from the current negative balance_due - no
 * separate stored date to drift out of sync.
 *
 * CHANGED per direct request: this used to invent its own "paid
 * through" date by counting days forward from credit ÷ rent, which
 * could land on a date days away from the landlord's actual due day
 * and encouraged a misleading countdown timer. It now takes the
 * REAL next due date (the same one the rest of the app already
 * computes from the landlord's due_day_of_month), advances it past
 * any cycles that are already fully covered by credit, and reports
 * against that - no invented date, no countdown, only "here's what
 * you'll owe, and exactly when."
 *
 * @param {number} balanceDue - tenant.balance_due (negative = credit)
 * @param {number} monthlyRent
 * @param {Date} nextDueDate - the real, landlord-set due date for the
 *   next cycle (already computed by the caller from due_day_of_month)
 */
function addMonths(date, n) {
  return new Date(date.getFullYear(), date.getMonth() + n, date.getDate());
}

// CHANGED per direct request ("don't just say fully covered/not
// covered - say precisely how many months, including a partial one,
// and exactly when the next real payment is due"):
//
// monthsCovered is a plain fraction - credit ÷ rent - e.g. 2.5 means
// 2 whole future months are paid for PLUS half of the third. That
// third, partially-covered cycle is the one a top-up is actually due
// for, so nextPaymentAmount is only the REMAINING uncovered slice of
// it (not a full month's rent), and nextPaymentDueDate is advanced
// past every fully-covered cycle first (nextDueDate is cycle #1's
// date - fullMonthsCovered more cycles are added on top of that to
// land on the first cycle that isn't fully paid for yet).
function buildPrepaymentSummary(balanceDue, monthlyRent, nextDueDate) {
  const credit = -Number(balanceDue || 0);
  if (credit <= 0 || monthlyRent <= 0) return { isAhead: false };

  const monthsCovered = credit / monthlyRent;
  // Tiny epsilon guards against float noise (e.g. 2.9999999999996)
  // landing one cycle short of where it should.
  const fullMonthsCovered = Math.floor(monthsCovered + 1e-9);
  const fractionCovered = Math.max(0, monthsCovered - fullMonthsCovered);

  const nextPaymentAmount = Math.round(monthlyRent * (1 - fractionCovered) * 100) / 100;
  const nextPaymentDueDate = addMonths(nextDueDate, fullMonthsCovered);

  return {
    isAhead: true,
    creditAmount: Math.round(credit * 100) / 100,
    monthsCovered: Math.round(monthsCovered * 10) / 10, // e.g. 2.5 - for "you've covered the next 2.5 months"
    fullMonthsCovered, // whole months only - kept for any existing callers
    nextPaymentAmount,
    nextPaymentDueDate,
  };
}

// FIX (fixes spec item 2.2, "receipts don't reflect advance/extra-month
// payments"): rent_period on the payment row used to always be just the
// current calendar month, even when the payment fully covered several
// months ahead - so a receipt for an advance payment looked identical
// to a receipt for an ordinary single-month payment, and gave no hint
// the tenant had paid ahead. When the payment leaves the tenant ahead
// (isAhead) and the credit spans more than one month, label the period
// as the full range it covers (starting from paidAtDate) instead of a
// single month, and say explicitly how many months that is.
// FIX (fixes spec item 2.2, "receipts don't reflect advance/extra-month
// payments"): rent_period on the payment row used to always be just the
// current calendar month, even when the payment fully covered several
// months ahead - so a receipt for an advance payment looked identical
// to a receipt for an ordinary single-month payment, and gave no hint
// the tenant had paid ahead. When the payment leaves the tenant ahead
// (isAhead) and the credit spans more than one month, label the period
// as the full range it covers (starting from paidAtDate) instead of a
// single month, and say explicitly how many months that is.
//
// UPDATED per direct request ("if one has covered 1.5 months or any
// amount past one month, show the balance remaining for that month
// and the month/date it applies to - the main period should always
// read as a complete month or months covered, never a fraction"):
// the headline period now only ever states whole months (never "1.5
// months"). Any leftover partial coverage - the fraction beyond the
// last whole month - is reported separately as its own clause: how
// much is still owed for that next month, and exactly which month/
// date that balance is against. monthlyRent is needed to turn that
// leftover fraction into a real KES amount, so it's now a required
// third argument.
function buildRentPeriodLabel(paidAtDate, prepaymentInfo, monthlyRent) {
  const base = paidAtDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  if (!prepaymentInfo?.isAhead || !prepaymentInfo.fullMonthsCovered) {
    return base;
  }

  const endDate = addMonths(paidAtDate, prepaymentInfo.fullMonthsCovered - 1);
  const end = endDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  let label = prepaymentInfo.fullMonthsCovered > 1
    ? `${base} – ${end} (${prepaymentInfo.fullMonthsCovered} months, paid in advance)`
    : `${base} (paid in full)`;

  // nextPaymentAmount < a full month's rent means there's a partial
  // credit sitting on top of the whole months already accounted for
  // above - e.g. 1.5 months covered: fullMonthsCovered=1 goes into the
  // label above, and this clause reports the remaining half-month.
  const rent = Number(monthlyRent || 0);
  if (rent > 0 && prepaymentInfo.nextPaymentAmount < rent - 0.5) {
    const credited = Math.round((rent - prepaymentInfo.nextPaymentAmount) * 100) / 100;
    const partialMonthLabel = prepaymentInfo.nextPaymentDueDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    label += `. KES ${credited.toLocaleString()} also credited toward ${partialMonthLabel} - KES ${prepaymentInfo.nextPaymentAmount.toLocaleString()} still due for that month.`;
  }
  return label;
}

module.exports = { applyPaymentToBalance, buildPrepaymentSummary, buildRentPeriodLabel };
