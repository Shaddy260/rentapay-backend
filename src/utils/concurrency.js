// src/utils/concurrency.js
//
// PERFORMANCE FIX (performance investigation): the daily cron jobs
// (monthlyBilling, rentReminders, subscriptionReminders) each loop over
// EVERY active tenant/landlord on the ENTIRE platform with a plain
// `for...of` + `await` per item - one DB write and/or one outbound
// SMS/email network call at a time, fully serial. That's fine at a
// handful of accounts; at real scale (thousands of tenants) it turns a
// job that should take a few seconds into one that takes minutes,
// because each item waits on the full round-trip of the one before it
// even though none of them depend on each other.
//
// runInBatches processes a limited number of items concurrently instead
// of either "all at once" (which can overwhelm the DB connection pool
// or trip an SMS provider's rate limit) or "one at a time" (slow). A
// single slow/failed item is caught and logged via onError rather than
// aborting the whole batch, so one bad row can never silently stop
// billing/reminders for everyone after it - the same reasoning already
// used in subscriptionReminders.job.js's per-landlord email try/catch,
// just generalized so every job gets it for free.
async function runInBatches(items, worker, { concurrency = 10, onError } = {}) {
  const queue = [...items];
  let active = 0;
  let index = 0;

  return new Promise((resolve) => {
    let settled = 0;
    if (items.length === 0) return resolve();

    function next() {
      while (active < concurrency && index < queue.length) {
        const item = queue[index];
        const itemIndex = index;
        index += 1;
        active += 1;

        Promise.resolve()
          .then(() => worker(item, itemIndex))
          .catch((err) => {
            if (onError) onError(err, item);
          })
          .finally(() => {
            active -= 1;
            settled += 1;
            if (settled === items.length) resolve();
            else next();
          });
      }
    }

    next();
  });
}

module.exports = { runInBatches };
