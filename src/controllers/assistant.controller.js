const supabase = require('../config/supabase');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

// Virtual Assistant spec: "Auto-launches once for a user's first login
// ... Re-accessible any time afterward via the same 'Assistant'
// floating button." That requires one durable, per-account bit of
// state - "has this account ever seen the walkthrough" - stored
// server-side so it survives across devices/browsers, not in
// localStorage (which a first login on a second device would never see).
//
// Every logged-in role (landlord, manager/caretaker, tenant) has its
// own account row in a different table - same pattern as
// credentials.controller.js's ROLE_TABLE - so this stays a tiny,
// role-agnostic table lookup rather than a new table of its own.
const ROLE_TABLE = { landlord: 'landlords', manager: 'property_managers', tenant: 'tenants' };

function tableForRole(role) {
  return ROLE_TABLE[role] || null;
}

async function getStatus(req, res) {
  try {
    const table = tableForRole(req.user.role);
    if (!table) return res.json({ hasSeenAssistant: true }); // unknown/admin roles: never auto-launch

    const { data, error } = await supabase
      .from(table)
      .select('has_seen_assistant')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw error;

    return res.json({ hasSeenAssistant: !!data?.has_seen_assistant });
  } catch (err) {
    logger.error('[assistant] getStatus error:', err.message);
    captureException(err);
    // Fail safe: if we can't tell, don't force the walkthrough open on
    // every single load - treat as already-seen and let the person
    // reopen it manually via the floating button if they want it.
    return res.json({ hasSeenAssistant: true });
  }
}

async function markSeen(req, res) {
  try {
    const table = tableForRole(req.user.role);
    if (!table) return res.json({ hasSeenAssistant: true });

    const { error } = await supabase.from(table).update({ has_seen_assistant: true }).eq('id', req.user.id);
    if (error) throw error;

    return res.json({ hasSeenAssistant: true });
  } catch (err) {
    logger.error('[assistant] markSeen error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to save assistant status.' });
  }
}

module.exports = { getStatus, markSeen };
