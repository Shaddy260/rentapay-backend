#!/usr/bin/env node
// scripts/diagnose-admin-login.js
//
// Standalone diagnostic for the super-admin login (mirrors
// scripts/diagnose-login.js's approach for landlord/tenant) - isolates
// whether an admin "Invalid password" is caused by (a) the DB-stored
// admin_password_hash column not existing yet, (b) SUPER_ADMIN_PASSWORD_HASH
// not being set, or (c) the password you're testing genuinely not
// matching whichever hash is actually in effect.
//
// This deliberately does NOT go through the Express server or
// adminLogin() itself - it talks to Supabase and bcrypt directly, so
// there's no ambiguity about which layer is misbehaving.
//
// Usage:
//   node scripts/diagnose-admin-login.js '<password-to-test>'
//
// Example:
//   node scripts/diagnose-admin-login.js 'MyAdminPassword123!'

require('dotenv').config();
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

const [, , passwordArg] = process.argv;

if (!passwordArg) {
  console.error("Usage: node scripts/diagnose-admin-login.js '<password-to-test>'");
  process.exit(1);
}

async function main() {
  console.log('================================================================');
  console.log(' RentaPay Admin Login Diagnostic');
  console.log('================================================================');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('FAIL: SUPABASE_URL or SUPABASE_SERVICE_KEY missing from .env. Fix this first - nothing else can be tested.');
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // -------------------------------------------------------------
  // STEP 1: does platform_settings.admin_password_hash even exist?
  // -------------------------------------------------------------
  console.log('\n--- STEP 1: platform_settings.admin_password_hash ---');
  const { data: settings, error: settingsErr } = await supabase
    .from('platform_settings')
    .select('admin_password_hash')
    .eq('id', 1)
    .maybeSingle();

  let dbHash = null;
  if (settingsErr) {
    console.log('Query FAILED:', settingsErr.message);
    if (/column .*admin_password_hash.* does not exist/i.test(settingsErr.message)) {
      console.log('=> The admin_password_hash column has not been added yet.');
      console.log('   Run this in the Supabase SQL Editor, then re-run this script:');
      console.log('');
      console.log('   alter table platform_settings add column if not exists admin_password_hash text;');
    }
  } else {
    dbHash = settings?.admin_password_hash || null;
    console.log(dbHash ? `Found a DB-stored hash: ${dbHash.slice(0, 15)}...` : 'Column exists but is currently NULL (no in-app password set yet).');
  }

  // -------------------------------------------------------------
  // STEP 2: is the env var set?
  // -------------------------------------------------------------
  console.log('\n--- STEP 2: SUPER_ADMIN_PASSWORD_HASH env var ---');
  const envHash = process.env.SUPER_ADMIN_PASSWORD_HASH || null;
  console.log(envHash ? `Found: ${envHash.slice(0, 15)}...` : 'NOT SET.');

  // -------------------------------------------------------------
  // STEP 3: which one does adminLogin() actually use?
  // -------------------------------------------------------------
  // Mirrors adminLogin()'s own logic exactly: DB hash wins if set,
  // otherwise falls back to the env var.
  const effectiveHash = dbHash || envHash;
  console.log('\n--- STEP 3: effective hash (DB takes priority over env var) ---');
  if (!effectiveHash) {
    console.log('NEITHER is set. This is why login returns 503, not 401 - there is');
    console.log('literally no password configured yet. Set SUPER_ADMIN_PASSWORD_HASH');
    console.log('in .env (see the fix command in the verdict below) to fix this.');
  } else {
    console.log(`Using: ${dbHash ? 'DB-stored hash (platform_settings.admin_password_hash)' : 'env var (SUPER_ADMIN_PASSWORD_HASH)'}`);
  }

  // -------------------------------------------------------------
  // STEP 4: bcrypt comparison against the password you're testing
  // -------------------------------------------------------------
  console.log('\n--- STEP 4: bcrypt comparison ---');
  let bcryptMatches = false;
  let validHashFormat = false;
  if (effectiveHash) {
    validHashFormat = /^\$2[aby]\$\d{2}\$/.test(effectiveHash);
    if (!validHashFormat) {
      console.log('The effective value is NOT a valid bcrypt hash (it may be plaintext,');
      console.log('or a copy-paste error). This alone would cause every password to fail.');
    } else {
      bcryptMatches = await bcrypt.compare(passwordArg, effectiveHash);
      console.log('Result:', bcryptMatches ? 'MATCH' : 'NO MATCH');
    }
  } else {
    console.log('Skipped - no hash to compare against.');
  }

  // -------------------------------------------------------------
  // VERDICT
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log(' VERDICT');
  console.log('================================================================');

  if (bcryptMatches) {
    console.log('bcrypt comparison SUCCEEDS with the password you tested. If the');
    console.log('real /api/auth/admin/login endpoint still returns 401 for this same');
    console.log('password, the mismatch is environment-specific - make sure the');
    console.log('server process actually has this .env loaded (check for a stale');
    console.log('process, a different .env in a deploy target, etc.) and restart it.');
  } else if (!effectiveHash) {
    console.log('No password is configured at all. Generate a proper hash and set it:');
    console.log('');
    console.log(`  node -e "require('bcrypt').hash('${passwordArg}', 10).then(console.log)"`);
    console.log('');
    console.log('Copy the printed hash into SUPER_ADMIN_PASSWORD_HASH in your .env,');
    console.log('then restart the server and log in with the password you just hashed.');
  } else if (!validHashFormat) {
    console.log('The effective hash is not valid bcrypt. Regenerate and replace it,');
    console.log('same command as above, then update whichever of .env or');
    console.log('platform_settings.admin_password_hash currently holds the bad value.');
  } else {
    console.log('The hash IS validly-formatted bcrypt, but does not match the password');
    console.log('you tested. This is the most common cause: the password you are');
    console.log('typing is not the one that was actually hashed - either a previous');
    console.log('"change admin password" attempt used a different value than you');
    console.log('think, or the env var was set from an older password. Fix by');
    console.log('generating a fresh hash of the password you actually want:');
    console.log('');
    console.log(`  node -e "require('bcrypt').hash('${passwordArg}', 10).then(console.log)"`);
    console.log('');
    console.log('...then either set that as SUPER_ADMIN_PASSWORD_HASH in .env (and');
    console.log('restart), or - if a DB hash is currently set and taking priority -');
    console.log('overwrite it directly:');
    console.log('');
    console.log("  update platform_settings set admin_password_hash = '<paste-hash-here>' where id = 1;");
  }
  console.log('================================================================');
}

main().catch((err) => {
  console.error('Unexpected error running diagnostic:', err);
  process.exit(1);
});
