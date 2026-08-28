// src/controllers/twoFactor.controller.js
//
// DIRECT REQUEST: 2FA mandatory for admin + general manager (see
// adminLogin/adminVerifyTotp and generalManagerLogin/
// generalManagerVerifyTotp in auth.controller.js), OPTIONAL for every
// other role (landlord, tenant, property manager/caretaker, brand
// ambassador) - this file is the self-service toggle those roles use
// from their own account-settings screen to turn it on/off for
// themselves. Uses TOTP (authenticator app), not email, per the
// direct request to avoid per-login email cost - see
// src/utils/totp.js for why.

const supabase = require('../config/supabase');
const { comparePassword } = require('../utils/password');
const {
  generateTotpSecret,
  verifyTotp,
  buildOtpAuthUrl,
  generateRecoveryCodes,
  hashRecoveryCode,
} = require('../utils/totp');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');

// Only roles that can self-toggle 2FA. Admin and general_manager are
// deliberately excluded - theirs is mandatory and managed by the
// dedicated admin/GM login flows, not this generic settings endpoint.
const SELF_SERVICE_TABLES = {
  landlord: 'landlords',
  tenant: 'tenants',
  manager: 'property_managers',
  brand_ambassador: 'brand_ambassadors',
};

function tableForRole(role) {
  return SELF_SERVICE_TABLES[role] || null;
}

// STEP 1 of enabling: generate a secret + QR code, but don't turn
// totp_enabled on yet - that only happens once the person proves they
// actually scanned it by submitting a valid code (see confirmEnable).
// Safe to call again before confirming; it just issues a fresh secret.
async function startEnable(req, res) {
  try {
    const { role, id } = req.user;
    const table = tableForRole(role);
    if (!table) return res.status(400).json({ error: '2FA is not available for this account type.' });

    const { data: account, error } = await supabase.from(table).select('email, totp_enabled').eq('id', id).maybeSingle();
    if (error || !account) return res.status(404).json({ error: 'Account not found.' });
    if (account.totp_enabled) return res.status(400).json({ error: '2FA is already enabled. Disable it first to re-enroll.' });

    const secret = generateTotpSecret();
    // Stored immediately (but totp_enabled stays false) so confirmEnable
    // below can verify against it without the client having to round-trip
    // the raw secret back - avoids a browser-history/clipboard leak path.
    await supabase.from(table).update({ totp_secret: secret }).eq('id', id);

    const otpauthUrl = buildOtpAuthUrl(secret, account.email || `${role}-${id}`);
    return res.json({ secret, otpauthUrl });
  } catch (err) {
    captureException?.(err);
    return res.status(500).json({ error: 'Failed to start 2FA setup.' });
  }
}

// STEP 2: confirm the app is actually working by submitting a live
// code, THEN flip totp_enabled on and hand back recovery codes (shown
// exactly once - only the hashes are kept).
async function confirmEnable(req, res) {
  try {
    const { role, id } = req.user;
    const { code } = req.body;
    const table = tableForRole(role);
    if (!table) return res.status(400).json({ error: '2FA is not available for this account type.' });

    const { data: account, error } = await supabase.from(table).select('totp_secret').eq('id', id).maybeSingle();
    if (error || !account?.totp_secret) return res.status(400).json({ error: 'No pending 2FA setup found. Start setup again.' });

    if (!verifyTotp(account.totp_secret, code)) {
      return res.status(400).json({ error: 'Incorrect code. Check the time on your device and try again.' });
    }

    const recoveryCodes = generateRecoveryCodes();
    await supabase
      .from(table)
      .update({ totp_enabled: true, totp_recovery_codes: recoveryCodes.map(hashRecoveryCode) })
      .eq('id', id);

    logActivity({ actorType: role, actorId: id, action: 'two_factor_enabled', ipAddress: req.ip });

    return res.json({
      enabled: true,
      recoveryCodes, // shown once, plaintext, never stored - save them now
      message: 'Two-factor authentication is now on. Save these recovery codes somewhere safe.',
    });
  } catch (err) {
    captureException?.(err);
    return res.status(500).json({ error: 'Failed to confirm 2FA setup.' });
  }
}

// Requires the account password (re-auth) plus either a live code or
// a recovery code, so a stolen/left-open session alone can't turn
// 2FA off.
async function disable(req, res) {
  try {
    const { role, id } = req.user;
    const { password, code } = req.body;
    const table = tableForRole(role);
    if (!table) return res.status(400).json({ error: '2FA is not available for this account type.' });

    const { data: account, error } = await supabase
      .from(table)
      .select('password_hash, totp_secret, totp_enabled, totp_recovery_codes')
      .eq('id', id)
      .maybeSingle();
    if (error || !account) return res.status(404).json({ error: 'Account not found.' });
    if (!account.totp_enabled) return res.status(400).json({ error: '2FA is not currently enabled.' });

    const passwordOk = await comparePassword(password || '', account.password_hash);
    if (!passwordOk) return res.status(401).json({ error: 'Incorrect password.' });

    const codeOk =
      verifyTotp(account.totp_secret, code) ||
      (account.totp_recovery_codes || []).includes(hashRecoveryCode(code || ''));
    if (!codeOk) return res.status(400).json({ error: 'Incorrect or missing verification code.' });

    await supabase.from(table).update({ totp_enabled: false, totp_secret: null, totp_recovery_codes: null }).eq('id', id);

    logActivity({ actorType: role, actorId: id, action: 'two_factor_disabled', ipAddress: req.ip });

    return res.json({ enabled: false, message: 'Two-factor authentication has been turned off.' });
  } catch (err) {
    captureException?.(err);
    return res.status(500).json({ error: 'Failed to disable 2FA.' });
  }
}

async function status(req, res) {
  try {
    const { role, id } = req.user;
    const table = tableForRole(role);
    if (!table) return res.json({ available: false, enabled: false });

    const { data: account } = await supabase.from(table).select('totp_enabled').eq('id', id).maybeSingle();
    return res.json({ available: true, enabled: !!account?.totp_enabled });
  } catch (err) {
    captureException?.(err);
    return res.status(500).json({ error: 'Failed to load 2FA status.' });
  }
}

module.exports = { startEnable, confirmEnable, disable, status, tableForRole };
