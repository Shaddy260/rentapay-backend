# Testing

This adds a first, deliberately narrow test suite - not full coverage,
just the three places a silent regression costs the most:

- `src/controllers/__tests__/auth.controller.login.test.js` - `login()`
- `src/utils/__tests__/phoneUniqueness.test.js` / `emailUniqueness.test.js` -
  `findPhoneConflict()` / `findEmailConflict()` (the archive-reuse bug class)
- `src/controllers/__tests__/payment.controller.callback.test.js` -
  `handleSTKCallback()` (the M-Pesa webhook)

## Setup

These tests need `jest` installed, which isn't in this bundle's
`node_modules` snapshot. From the `backend/` folder, with network
access:

```bash
npm install
npm test
```

`npm test` runs `jest` (config in `jest.config.js`). `npm run
test:watch` re-runs on file changes.

## How the tests avoid a real database

Every test mocks `src/config/supabase.js` with the helper in
`src/test-utils/supabaseMock.js` - a small chainable stand-in for the
supabase-js query builder that resolves `.eq()/.ilike()/.select()/...`
chains to a `{ data, error }` result you configure per table, without
touching a real database, and without needing `SUPABASE_URL` /
`SUPABASE_SERVICE_KEY` set. Outbound side effects (email, SMS/notify,
activity log, Sentry, JWT signing) are also mocked, so these tests run
in milliseconds and only fail when the function *under test* changes
behavior - not because a collaborator's shape changed.

## Extending this later

The same `setupSupabaseMock()` helper works for any other
controller/util that goes through `src/config/supabase.js`. The
natural next candidates, in rough priority order, are:
1. `registerLandlord` / `verifyOTP` (auth.controller.js) - the rest of
   the account-creation funnel `login()` sits downstream of.
2. `addTenant` / `addManager` - the two other callers of
   `findPhoneConflict`/`findEmailConflict`.
3. `processSubscriptionPaymentCallback` /
   `processPropertyPaymentCallback` in payment.controller.js - not
   directly tested here (they're not exported), only exercised
   indirectly through `handleSTKCallback`.
