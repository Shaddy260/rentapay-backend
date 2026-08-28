// src/utils/latePenalty.js
//
// Single shared calculation engine for the late-payment penalty
// feature - mirrors the calculateSubscriptionCost() pattern in
// utils/pricing.js: ONE function, called from every screen that ever
// shows a penalty figure (tenant dashboard, landlord dashboard,
// statements, reminders, receipts), so there is no risk of two
// screens showing two different numbers for the same tenant.
//
// This is OFF by default and entirely opt-in per landlord (see
// sql/2026-08-late-payment-penalty.sql + latePenalty.service.js). It
// never mutates balance_due or any other stored figure - it is
// always computed live, on read, from: the landlord's settings, the
// tenant's outstanding balance, the due date that balance has been
// outstanding since, and whatever payments landed on/after that due
// date (which piecewise-reduce the base the penalty accrues on, per
// the "recalculates against the remaining unpaid balance" rule).
//
// NOTE on scope: RentaPay does not currently keep a full historical
// per-billing-cycle ledger of exact charge/payment events (balance_due
// is a single running figure, see tenant.controller.js). This utility
// works with what the schema actually has today: the CURRENT
// outstanding balance, the due date it has been outstanding since,
// and any payments recorded for that tenant on/after that due date.
// That is enough to satisfy the spec's actual requirements (walk the
// payment timeline, piecewise-accrue against the shrinking balance,
// return a stretch-by-stretch breakdown, respect overrides) without a
// risky rewrite of how balances are tracked elsewhere in the app.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function wholePeriodsBetween(fromDate, toDate, accrualUnit) {
  const from = startOfDay(fromDate);
  const to = startOfDay(toDate);
  const diffDays = Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
  if (diffDays <= 0) return 0;
  return accrualUnit === 'week' ? Math.floor(diffDays / 7) : diffDays;
}

/**
 * @param {object} params
 * @param {number} params.outstandingBalance - current amount owed (>= 0), as of `asOf`
 * @param {Date|string} params.dueDate - the due date this balance has been outstanding since
 * @param {Array<{amount:number, paidAt:Date|string}>} [params.payments] - payments on/after dueDate that reduced the balance, chronological or not (will be sorted)
 * @param {object} params.settings - landlord's penalty settings
 * @param {boolean} params.settings.enabled
 * @param {'day'|'week'} params.settings.accrualUnit
 * @param {number} params.settings.ratePercent - e.g. 0.5 means 0.5% per accrual unit
 * @param {boolean} params.settings.capEnabled
 * @param {number|null} params.settings.capPercent - max penalty as % of outstandingBalance
 * @param {object|null} [params.override] - active override for this tenant/period, if any
 * @param {'waive'|'custom_amount'|'custom_rate'} [params.override.type]
 * @param {number} [params.override.value]
 * @param {Date|string} [params.asOf] - defaults to now
 * @returns {{penaltyAmount:number, outstandingBalance:number, periodsOverdue:number, calculationBreakdown:Array, overrideApplied:object|null, isOverdue:boolean}}
 */
function calculateLatePenalty({ outstandingBalance, dueDate, payments = [], settings, override = null, asOf = new Date() }) {
  const balance = Math.max(0, Number(outstandingBalance) || 0);
  const due = new Date(dueDate);
  const now = new Date(asOf);

  const base = {
    penaltyAmount: 0,
    outstandingBalance: Math.round(balance * 100) / 100,
    periodsOverdue: 0,
    calculationBreakdown: [],
    overrideApplied: null,
    isOverdue: balance > 0 && now > due,
  };

  // Never accrues while the master switch is off, before the due
  // date, or when nothing is actually owed - no grace period, but
  // also no accrual on money that isn't outstanding.
  if (!settings || !settings.enabled || balance <= 0 || now <= due) {
    return base;
  }

  // An active waiver short-circuits everything else - forced to 0,
  // clearly attributable, never a silent adjustment.
  if (override && override.type === 'waive') {
    return {
      ...base,
      periodsOverdue: wholePeriodsBetween(due, now, settings.accrualUnit),
      overrideApplied: { type: 'waive', reason: override.reason || null, appliedBy: override.appliedBy || null, appliedAt: override.appliedAt || null },
    };
  }

  // A custom flat amount also short-circuits the formula entirely -
  // still shown with the override attribution, never blended with a
  // computed figure.
  if (override && override.type === 'custom_amount') {
    const amt = Math.max(0, Number(override.value) || 0);
    return {
      ...base,
      penaltyAmount: Math.round(amt * 100) / 100,
      periodsOverdue: wholePeriodsBetween(due, now, settings.accrualUnit),
      overrideApplied: { type: 'custom_amount', value: amt, reason: override.reason || null, appliedBy: override.appliedBy || null, appliedAt: override.appliedAt || null },
    };
  }

  // A custom rate replaces the property-default rate for just this
  // tenant/period, but still runs through the normal piecewise walk
  // below (still capped by the normal cap settings, unless the
  // landlord/manager also wants a fully custom amount - that's
  // custom_amount above).
  const effectiveRatePercent = override && override.type === 'custom_rate' && override.value != null
    ? Number(override.value)
    : Number(settings.ratePercent) || 0;

  // ---- Piecewise walk over the payment timeline ----
  // Sort payments chronologically; only ones on/after the due date
  // are relevant (earlier payments already reduced the base that
  // outstandingBalance/dueDate reflect).
  const events = (payments || [])
    .map((p) => ({ amount: Number(p.amount) || 0, paidAt: new Date(p.paidAt) }))
    .filter((p) => p.paidAt >= due && p.paidAt <= now)
    .sort((a, b) => a.paidAt - b.paidAt);

  let cursor = due;
  let runningBalance = balance;
  // Reconstruct the balance at the START of the overdue window by
  // adding back whatever was later paid down, so the FIRST stretch
  // (due date -> first payment) accrues against the full original
  // amount, not today's already-reduced figure.
  const totalLaterPayments = events.reduce((s, e) => s + e.amount, 0);
  runningBalance = balance + totalLaterPayments;

  const breakdown = [];
  let totalPenalty = 0;

  for (const ev of events) {
    const periods = wholePeriodsBetween(cursor, ev.paidAt, settings.accrualUnit);
    if (periods > 0) {
      const stretchPenalty = runningBalance * (effectiveRatePercent / 100) * periods;
      totalPenalty += stretchPenalty;
      breakdown.push({
        from: cursor.toISOString(),
        to: ev.paidAt.toISOString(),
        balanceDuringStretch: Math.round(runningBalance * 100) / 100,
        periodsInStretch: periods,
        penaltyForStretch: Math.round(stretchPenalty * 100) / 100,
      });
      cursor = ev.paidAt;
    }
    runningBalance = Math.max(0, runningBalance - ev.amount);
  }

  // Final stretch: last event (or due date, if no payments) -> now.
  const finalPeriods = wholePeriodsBetween(cursor, now, settings.accrualUnit);
  if (finalPeriods > 0) {
    const stretchPenalty = runningBalance * (effectiveRatePercent / 100) * finalPeriods;
    totalPenalty += stretchPenalty;
    breakdown.push({
      from: cursor.toISOString(),
      to: now.toISOString(),
      balanceDuringStretch: Math.round(runningBalance * 100) / 100,
      periodsInStretch: finalPeriods,
      penaltyForStretch: Math.round(stretchPenalty * 100) / 100,
    });
  }

  let penalty = totalPenalty;
  if (settings.capEnabled && settings.capPercent != null) {
    const cap = balance * (Number(settings.capPercent) / 100);
    penalty = Math.min(penalty, cap);
  }

  return {
    ...base,
    penaltyAmount: Math.round(penalty * 100) / 100,
    periodsOverdue: wholePeriodsBetween(due, now, settings.accrualUnit),
    calculationBreakdown: breakdown,
    overrideApplied: override && override.type === 'custom_rate'
      ? { type: 'custom_rate', value: effectiveRatePercent, reason: override.reason || null, appliedBy: override.appliedBy || null, appliedAt: override.appliedAt || null }
      : null,
  };
}

module.exports = { calculateLatePenalty };
