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

module.exports = { applyPaymentToBalance, buildPrepaymentSummary };
