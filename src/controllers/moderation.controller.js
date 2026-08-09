// src/controllers/moderation.controller.js
//
// FEATURE (direct request): admin-side actions on accounts flagged
// via Community reports (community.controller.js's reportContent) -
// warn, suspend permanently, suspend temporarily for a chosen
// duration, or lift a suspension. Also the "Reported accounts" admin
// screen: warned / temporarily suspended / suspended tabs, each
// showing how many times an account has been warned and reported.

const supabase = require('../config/supabase');
const { notify } = require('../services/notify.service');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const ACCOUNT_TABLES = {
  landlord: 'landlords',
  manager: 'property_managers',
  tenant: 'tenants',
};

function accountLabel(accountType, account) {
  if (accountType === 'manager') return `${account.full_name} (${account.role_level === 'caretaker' ? 'caretaker' : 'manager'})`;
  return account.full_name;
}

/**
 * GET /api/admin/moderation/reports - open (unreviewed) reports, most
 * recent first. Each report carries reported_type/reported_id so the
 * admin UI can show "warn"/"suspend" actions right next to it.
 */
async function listReports(req, res) {
  try {
    const status = req.query.status || 'open';
    const { data, error } = await supabase
      .from('community_reports')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return res.json({ reports: data || [] });
  } catch (err) {
    logger.error('[moderation] listReports error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load reports.' });
  }
}

/**
 * GET /api/admin/moderation/accounts?tab=warned|suspended|temporary
 * "Reported accounts" screen - one tab per moderation state, each
 * account showing warning_count and report_count so a repeat offender
 * is obvious at a glance.
 */
async function listModeratedAccounts(req, res) {
  try {
    const tab = req.query.tab || 'warned';
    const results = [];

    for (const [accountType, table] of Object.entries(ACCOUNT_TABLES)) {
      let query = supabase.from(table).select('id, full_name, email, warning_count, report_count, suspended_permanently, suspended_until, suspension_reason' + (accountType === 'manager' ? ', role_level' : ''));
      if (tab === 'suspended') query = query.eq('suspended_permanently', true);
      else if (tab === 'temporary') query = query.not('suspended_until', 'is', null).eq('suspended_permanently', false);
      else query = query.gt('warning_count', 0).eq('suspended_permanently', false).is('suspended_until', null);

      const { data, error } = await query;
      if (error) throw error;
      for (const account of data || []) {
        // A temporary suspension that has already expired shouldn't
        // keep showing under "Temporary" - it's effectively lapsed,
        // even though the row hasn't been cleared yet.
        if (tab === 'temporary' && new Date(account.suspended_until) <= new Date()) continue;
        results.push({ accountType, ...account, label: accountLabel(accountType, account) });
      }
    }

    return res.json({ accounts: results });
  } catch (err) {
    logger.error('[moderation] listModeratedAccounts error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load moderated accounts.' });
  }
}

async function loadAccount(accountType, accountId) {
  const table = ACCOUNT_TABLES[accountType];
  if (!table) return null;
  const { data } = await supabase.from(table).select('*').eq('id', accountId).maybeSingle();
  return data ? { table, account: data } : null;
}

async function logModerationAction(accountType, accountId, action, reason, suspendedUntil) {
  await supabase.from('account_moderation_actions').insert({
    account_type: accountType,
    account_id: accountId,
    action,
    reason: reason || null,
    suspended_until: suspendedUntil || null,
  });
}

/** POST /api/admin/moderation/:accountType/:accountId/warn */
async function warnAccount(req, res) {
  try {
    const { accountType, accountId } = req.params;
    const { reason, reportId } = req.body;
    const found = await loadAccount(accountType, accountId);
    if (!found) return res.status(404).json({ error: 'Account not found.' });

    const newCount = (found.account.warning_count || 0) + 1;
    const { error } = await supabase.from(found.table).update({ warning_count: newCount }).eq('id', accountId);
    if (error) throw error;

    await logModerationAction(accountType, accountId, 'warned', reason);
    if (reportId) await supabase.from('community_reports').update({ status: 'warned', reviewed_at: new Date().toISOString() }).eq('id', reportId);

    await notify(
      accountType,
      accountId,
      null,
      `Warning from RentaPay: ${reason || 'content you posted was reported and reviewed'}. Your account may be suspended if this continues, as it violates RentaPay's Terms and Conditions.`,
      { category: 'account', title: 'Account warning' }
    ).catch((notifyErr) => logger.error('[moderation] warnAccount notify failed:', notifyErr.message));

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'account_warned', targetType: accountType, targetId: accountId, reason, ipAddress: req.ip });

    return res.json({ message: 'Warning sent.', warningCount: newCount });
  } catch (err) {
    logger.error('[moderation] warnAccount error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to warn account.' });
  }
}

/** POST /api/admin/moderation/:accountType/:accountId/suspend - permanent. */
async function suspendAccountPermanently(req, res) {
  try {
    const { accountType, accountId } = req.params;
    const { reason, reportId } = req.body;
    const found = await loadAccount(accountType, accountId);
    if (!found) return res.status(404).json({ error: 'Account not found.' });

    const { error } = await supabase
      .from(found.table)
      .update({ suspended_permanently: true, suspended_until: null, suspension_reason: reason || null })
      .eq('id', accountId);
    if (error) throw error;

    await logModerationAction(accountType, accountId, 'suspended_permanent', reason);
    if (reportId) await supabase.from('community_reports').update({ status: 'suspended', reviewed_at: new Date().toISOString() }).eq('id', reportId);

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'account_suspended_permanent', targetType: accountType, targetId: accountId, reason, ipAddress: req.ip });

    return res.json({ message: 'Account suspended indefinitely.' });
  } catch (err) {
    logger.error('[moderation] suspendAccountPermanently error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to suspend account.' });
  }
}

/** POST /api/admin/moderation/:accountType/:accountId/suspend-temporary - { days, reason, reportId } */
async function suspendAccountTemporarily(req, res) {
  try {
    const { accountType, accountId } = req.params;
    const { days, reason, reportId } = req.body;
    const numDays = Number(days);
    if (!numDays || numDays < 1) return res.status(400).json({ error: 'Please choose how many days to suspend for.' });

    const found = await loadAccount(accountType, accountId);
    if (!found) return res.status(404).json({ error: 'Account not found.' });

    const suspendedUntil = new Date();
    suspendedUntil.setDate(suspendedUntil.getDate() + numDays);

    const { error } = await supabase
      .from(found.table)
      .update({ suspended_permanently: false, suspended_until: suspendedUntil.toISOString(), suspension_reason: reason || null })
      .eq('id', accountId);
    if (error) throw error;

    await logModerationAction(accountType, accountId, 'suspended_temporary', reason, suspendedUntil.toISOString());
    if (reportId) await supabase.from('community_reports').update({ status: 'suspended', reviewed_at: new Date().toISOString() }).eq('id', reportId);

    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'account_suspended_temporary', targetType: accountType, targetId: accountId, reason, metadata: { days: numDays }, ipAddress: req.ip });

    return res.json({ message: `Account suspended for ${numDays} day(s), until ${suspendedUntil.toLocaleString()}.`, suspendedUntil: suspendedUntil.toISOString() });
  } catch (err) {
    logger.error('[moderation] suspendAccountTemporarily error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to suspend account.' });
  }
}

/** POST /api/admin/moderation/:accountType/:accountId/unsuspend */
async function unsuspendAccount(req, res) {
  try {
    const { accountType, accountId } = req.params;
    const found = await loadAccount(accountType, accountId);
    if (!found) return res.status(404).json({ error: 'Account not found.' });

    const { error } = await supabase
      .from(found.table)
      .update({ suspended_permanently: false, suspended_until: null, suspension_reason: null })
      .eq('id', accountId);
    if (error) throw error;

    await logModerationAction(accountType, accountId, 'unsuspended', null);
    logActivity({ actorType: 'admin', actorId: 'super-admin', action: 'account_unsuspended', targetType: accountType, targetId: accountId, ipAddress: req.ip });

    return res.json({ message: 'Suspension lifted.' });
  } catch (err) {
    logger.error('[moderation] unsuspendAccount error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to lift suspension.' });
  }
}

/** GET /api/admin/moderation/:accountType/:accountId/history */
async function getModerationHistory(req, res) {
  try {
    const { accountType, accountId } = req.params;
    const { data, error } = await supabase
      .from('account_moderation_actions')
      .select('*')
      .eq('account_type', accountType)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ history: data || [] });
  } catch (err) {
    logger.error('[moderation] getModerationHistory error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load moderation history.' });
  }
}

module.exports = {
  listReports,
  listModeratedAccounts,
  warnAccount,
  suspendAccountPermanently,
  suspendAccountTemporarily,
  unsuspendAccount,
  getModerationHistory,
};
