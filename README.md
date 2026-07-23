# RentaPay Backend

## This pass: fixing registration crashes, orphan records, and the login 401

You reported three connected problems. Here's exactly what was actually
wrong, in order of how they chain together:

### Root cause #1: `registerLandlord` never recorded a row in `subscription_payments`

This was the deepest bug, and it would have caused failures **even with
real, working Daraja credentials**. The controller called
`initiateSTKPush()`, got back a `CheckoutRequestID`, and then just...
never stored it anywhere. When Safaricom's callback later arrives,
`handleSTKCallback` looks up `subscription_payments` by
`mpesa_checkout_request_id` to figure out which account to activate -
with no row to find, it silently no-ops. The landlord would pay
successfully and the account would still never activate.

**Fixed**: `registerLandlord` now inserts a `subscription_payments` row
right after the STK push succeeds, with the real `checkoutRequestId`
attached.

### Root cause #2: no rollback on STK push failure -> orphan records

The original order was: insert landlord row -> call `initiateSTKPush()`.
If the Daraja call threw for any reason (bad credentials, unreachable
sandbox, invalid callback URL) and there was no error handling around
it, the function just crashed with the row already committed. Next
registration attempt with the same phone hit "Account already exists"
forever, with no way to recover except manual deletion.

**Fixed**: the STK push call is now wrapped; on failure, the landlord
row is deleted before returning an error. Additionally, if you find a
genuinely stuck `subscription_status = 'pending'` row from before this
fix shipped, a new registration attempt with the same phone now
auto-deletes the stale pending row and proceeds, instead of permanently
blocking that phone number.

### Root cause #3 (your actual 401): plaintext password manually pasted into Supabase

`comparePassword()` runs `bcrypt.compare(plainPassword, hash)`. If
`password_hash` contains a plaintext string instead of a real bcrypt
hash, this **always** returns `false` - there's no bcrypt structure to
compare against. This is unrelated to `is_verified` or
`subscription_status`; in fact, **`login()` doesn't check
`subscription_status` at all** - only `is_verified`, `locked_until`,
and the password hash matter for login. So manually flipping
`subscription_status` to `'active'` was never going to fix this.

**Fixed / provided**:
- `scripts/diagnose-login.js` - standalone script, run from the
  terminal, that checks the query result and the hash format in
  isolation and tells you exactly which layer is broken.
- A `DEBUG_AUTH=true` env flag that logs the same diagnostic info
  inline in `login()` right before the comparison - hard-gated to
  never run when `NODE_ENV=production`.
- `sql/manual-account-activation.sql` - the *complete* correct set of
  fields to update for a manual test activation, including generating
  a real bcrypt hash first instead of pasting plaintext.

## New: `MOCK_DARAJA` bypass for development

Set `MOCK_DARAJA=true` in `.env` and `initiateSTKPush()` returns a fake
(but correctly-shaped) response instantly - no real network call, no
sandbox credentials needed, no phone required. Calling code
(`registerLandlord`, `renewSubscription`, etc.) needs zero
special-casing since the shape matches Safaricom's real response exactly.

**The catch**: with no real STK push, Safaricom never calls your
callback URL, so nothing ever completes the payment automatically. Use
the new dev-only route to simulate it:

```bash
curl -X POST http://localhost:5000/api/dev/simulate-payment-success \
  -H "Content-Type: application/json" \
  -d '{"checkoutRequestId": "ws_CO_MOCK_xxxx", "amount": 750, "phone": "254712345678"}'
```

This builds a synthetic Daraja callback body and routes it through the
real `handleSTKCallback()` handler - same code path production uses,
not a separate reimplementation. Works for both landlord subscription
payments and tenant rent payments.

`/api/dev/*` is only mounted when `NODE_ENV !== 'production'` (see
`server.js`) - the route tree is structurally absent in production, not
just access-checked.

## Diagnosing a 401 on login

```bash
node scripts/diagnose-login.js 254712345678 'TheirPassword123!' landlord
```

This runs the exact query `login()` runs, then inspects whether
`password_hash` is actually a valid bcrypt hash, then runs the real
`bcrypt.compare()` in isolation - and tells you in plain language which
of the three is the problem, plus the exact fix command.

## Manually activating an account (testing/seeding)

See `sql/manual-account-activation.sql`. Short version: generate a real
hash first -

```bash
node -e "require('bcrypt').hash('YourTestPassword123!', 12).then(h => console.log(h))"
```

then set `password_hash` to that output (not your plaintext password),
plus `is_verified = true` and `locked_until = null`. Setting
`subscription_status` alone does nothing for login.

## Everything from the previous pass still applies

(Full schema, all controllers, cron jobs, etc. - see `sql/schema.sql`
and the rest of `src/`. Setup steps below unchanged.)

### Setup steps

```bash
npm install
cp .env.example .env   # fill in real values, or set MOCK_DARAJA=true to skip Daraja entirely
npm run dev
```

Visit `http://localhost:5000/health` to confirm it's actually running
before assuming a proxy/CORS problem on the frontend side - a backend
that crashed on startup looks identical to a proxy misconfiguration
from the frontend's perspective (`ECONNREFUSED` either way).

## Verification note

This sandbox has no network access to run `npm install` against the
real registry, so the full registration -> payment -> OTP -> login
chain was verified by running the actual, unmodified controller
functions against a purpose-built in-memory fake of the Supabase
client (supporting insert/select/update/delete/eq/joins) plus a
bcrypt-shaped stub. This caught one real bug during testing - a missing
null-check in `processSubscriptionPaymentCallback` when a joined
landlord row is absent - which is now fixed defensively in the real
code, not just worked around in the test. You'll still want to run this
against your real Supabase project before deploying, but the control
flow itself has been exercised, not just syntax-checked.
