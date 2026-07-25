// src/utils/overdue.js
//
// Formerly src/utils/interest.js. The late-payment interest feature
// (0.5%/day charge, "waive interest" UI/endpoint) has been removed
// entirely per direct request - late payments are still tracked (this
// file's daysOverdue is used for overdue reminders and flags) but no
// longer accrue any extra charge on top of what's actually owed.

/**
 * Calculates how many whole days a payment is overdue.
 * @param {Date} dueDate
 * @param {Date} asOf - defaults to now
 */
function daysOverdue(dueDate, asOf = new Date()) {
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const now = new Date(asOf);
  now.setHours(0, 0, 0, 0);

  const diffMs = now.getTime() - due.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}

module.exports = { daysOverdue };
