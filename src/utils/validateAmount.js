// src/utils/validateAmount.js
//
// HARDENING (2B - input validation audit): several endpoints accepted
// any user-supplied "amount"-shaped field (rent, extra charges,
// manual/paybill payment amounts) with only a truthy/falsy check
// (e.g. `!rentAmount`), which lets a negative number, a string like
// "abc", NaN, or Infinity straight through to the database. This is a
// tiny, additive helper every controller can reuse instead of each
// writing its own ad hoc check - matches the project's existing style
// of small single-purpose files in utils/ (see phone.js, pricing.js).
//
// Returns the coerced positive number, or null if the input isn't a
// finite number greater than 0 (or >= 0 when allowZero is true).
// Never throws - callers keep their existing `if (...) return
// res.status(400)...` style rather than a new try/catch pattern.
function validatePositiveAmount(value, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (allowZero ? num < 0 : num <= 0) return null;
  return num;
}

module.exports = { validatePositiveAmount };
