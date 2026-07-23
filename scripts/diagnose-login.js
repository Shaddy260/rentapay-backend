#!/usr/bin/env node
// scripts/diagnose-login.js
//
// Standalone diagnostic - run directly from the terminal to isolate
// whether a login failure is caused by (a) the Supabase query not
// finding/returning the row you expect, or (b) bcrypt comparison
// failing against whatever is actually stored in password_hash.
//
// This deliberately does NOT go through the Express server or the
// login() controller - it talks to Supabase and bcrypt directly, so
// there's no ambiguity about which layer is misbehaving.
//
// Usage:
//   node scripts/diagnose-login.js <phone> <password-to-test> [accountType]
//
// Example:
//   node scripts/diagnose-login.js 254712345678 'MyPassword123!' landlord

require('dotenv').config();
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

const [, , phoneArg, passwordArg, accountTypeArg] = process.argv;

if (!phoneArg || !passwordArg) {
  console.error('Usage: node scripts/diagnose-login.js <phone> <password-to-test> [landlord|tenant]');
  process.exit(1);
}

const accountType = accountTypeArg === 'tenant' ? 'tenant' : 'landlord';
const table = accountType === 'landlord' ? 'landlords' : 'tenants';
const phoneField = accountType === 'landlord' ? 'phone' : 'primary_phone';

async function main() {
  console.log('================================================================');
  console.log(' RentaPay Login Diagnostic');
  console.log('================================================================');
  console.log(`Table:        ${table}`);
  console.log(`Phone field:  ${phoneField}`);
  console.log(`Looking up:   ${phoneArg}`);
  console.log('----------------------------------------------------------------');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('FAIL: SUPABASE_URL or SUPABASE_SERVICE_KEY missing from .env. Fix this first - nothing else can be tested.');
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // -----------------------------------------------------------------
  // STEP 1: the query, in isolation
  // -----------------------------------------------------------------
  console.log('\n[STEP 1] Running the exact query login() runs...');
  const { data: account, error, status, statusText } = await supabase
    .from(table)
    .select('*')
    .eq(phoneField, phoneArg)
    .maybeSingle();

  if (error) {
    console.error('FAIL: Supabase query returned an error object.');
    console.error('  HTTP status:', status, statusText);
    console.error('  Error:', error.message);
    console.error('  -> This points at a query/schema/permissions problem, not bcrypt.');
    console.error('     Common causes: wrong table/column name, RLS policy blocking');
    console.error('     the service-role key (shouldn\'t happen, but check), or a');
    console.error('     malformed SUPABASE_SERVICE_KEY.');
    process.exit(1);
  }

  if (!account) {
    console.error(`FAIL: Query succeeded but found NO row where ${phoneField} = '${phoneArg}'.`);
    console.error('  -> This is a query/data problem: either the phone number');
    console.error('     stored in the table is formatted differently than you\'re');
    console.error('     testing with (e.g. "0712..." in the DB vs "254712..." here),');
    console.error('     or the row genuinely does not exist - check the table directly');
    console.error('     in the Supabase dashboard.');
    process.exit(1);
  }

  console.log('OK: Query found exactly one matching row.');
  console.log('  id:', account.id);
  console.log('  is_verified:', account.is_verified);
  console.log('  subscription_status:', account.subscription_status ?? '(n/a for tenants)');
  console.log('  locked_until:', account.locked_until);
  console.log('  failed_login_attempts:', account.failed_login_attempts);

  // -----------------------------------------------------------------
  // STEP 2: inspect the stored hash's shape (no need to decode it -
  // bcrypt hashes have a fixed, recognizable structure)
  // -----------------------------------------------------------------
  console.log('\n[STEP 2] Inspecting password_hash...');
  const hash = account.password_hash || '';
  const bcryptPattern = /^\$2[aby]\$(\d{2})\$[A-Za-z0-9./]{53}$/;
  const match = hash.match(bcryptPattern);

  console.log('  Stored value length:', hash.length, 'characters');
  console.log('  First 10 chars:', JSON.stringify(hash.slice(0, 10)));

  if (!match) {
    console.error('\nFAIL: password_hash is NOT a validly-formatted bcrypt hash.');
    console.error('  A real bcrypt hash always looks like: $2b$12$<53 more characters>');
    console.error('  -> THIS IS YOUR BUG. bcrypt.compare() will return false against');
    console.error('     this value no matter what password is submitted, because');
    console.error('     there is no valid hash structure to compare against.');
    console.error('  -> You almost certainly pasted a plaintext password directly');
    console.error('     into the Supabase table editor. Fix: generate a real hash');
    console.error('     and update the row - see the SQL/command at the bottom of');
    console.error('     this script\'s output, or just re-register through the API');
    console.error('     so hashPassword() runs normally.');
  } else {
    console.log('  OK: Looks like a valid bcrypt hash (cost factor:', match[1] + ').');
  }

  // -----------------------------------------------------------------
  // STEP 3: the actual bcrypt comparison, in isolation
  // -----------------------------------------------------------------
  console.log('\n[STEP 3] Running bcrypt.compare(submittedPassword, storedHash)...');
  let bcryptMatches = false;
  try {
    bcryptMatches = await bcrypt.compare(passwordArg, hash);
  } catch (err) {
    console.error('FAIL: bcrypt.compare() threw an error:', err.message);
    console.error('  -> This usually means the stored value isn\'t a string bcrypt');
    console.error('     can even attempt to parse (e.g. null, or a non-bcrypt format).');
    process.exit(1);
  }

  console.log('  Result:', bcryptMatches ? 'MATCH' : 'NO MATCH');

  // -----------------------------------------------------------------
  // STEP 4: verdict + fix command
  // -----------------------------------------------------------------
  console.log('\n================================================================');
  console.log(' VERDICT');
  console.log('================================================================');

  if (bcryptMatches) {
    console.log('bcrypt comparison SUCCEEDS with the password and hash currently');
    console.log('in the database. If your login endpoint still returns 401, the');
    console.log('bug is NOT in bcrypt or the query - check is_verified,');
    console.log('locked_until, or subscription_status gating in login() instead.');
  } else if (!match) {
    console.log('password_hash is not a real bcrypt hash - this is the cause of');
    console.log('your 401. Fix it by generating a proper hash and writing it back:');
    console.log('');
    console.log(`  node -e "require('bcrypt').hash('${passwordArg}', 12).then(h => console.log(h))"`);
    console.log('');
    console.log('Copy the printed hash, then in Supabase SQL Editor run:');
    console.log('');
    console.log(`  update ${table} set password_hash = '<paste-hash-here>' where id = '${account.id}';`);
  } else {
    console.log('password_hash IS a validly-formatted bcrypt hash, but it does not');
    console.log('match the password you tested. This means the hash in the');
    console.log('database was generated from a DIFFERENT password than you think -');
    console.log('most likely you registered with one password and are now testing');
    console.log('a different one, or a previous manual edit overwrote it with a');
    console.log('hash of something else. Fix by re-generating a hash of the');
    console.log('password you actually want, the same way as above.');
  }
  console.log('================================================================');
}

main().catch((err) => {
  console.error('Unexpected error running diagnostic:', err);
  process.exit(1);
});
