// src/controllers/settings.controller.js
//
// Backs Admin > Settings > "Help & Contact Details" and every portal's
// Help modal (which reads the PUBLIC endpoint - no login required,
// since the Help button is visible on the logged-out login screen
// too).
//
// Uses its own table (admin_help_contact_settings) rather than the
// project's existing `platform_settings` row - that table is already
// a fixed single row (id=1: is_locked_down / lockdown_reason /
// admin_password_hash, see auth.controller.js's adminLogin), not a
// key/value store, so this feature gets a dedicated table instead of
// overloading that one. See the migration for details.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { captureException } = require('../services/sentry.service');

const HELP_KEYS = {
  helpWhatsapp: 'help_whatsapp',
  helpCall: 'help_call',
  helpEmail: 'help_email',
};

const DEFAULTS = {
  helpWhatsapp: '+254710888917',
  helpCall: '254710888917',
  helpEmail: 'support@rentapay.co.ke',
};

async function fetchHelpContacts() {
  const { data, error } = await supabase
    .from('admin_help_contact_settings')
    .select('key, value')
    .in('key', Object.values(HELP_KEYS));
  if (error) throw error;

  const byKey = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return {
    helpWhatsapp: byKey.help_whatsapp || DEFAULTS.helpWhatsapp,
    helpCall: byKey.help_call || DEFAULTS.helpCall,
    helpEmail: byKey.help_email || DEFAULTS.helpEmail,
  };
}

// GET /api/settings/public/help-contacts - unauthenticated.
async function getPublicHelpContacts(req, res) {
  try {
    const contacts = await fetchHelpContacts();
    res.json(contacts);
  } catch (err) {
    // Never fail hard here - a broken DB connection shouldn't take
    // down every Help button on the site - fall back to the same
    // defaults the frontend already assumed before this existed.
    logger.error('[settings] getPublicHelpContacts failed, returning defaults', err);
    captureException(err);
    res.json(DEFAULTS);
  }
}

// GET /api/admin/settings - authenticated admin. Currently just the
// help contacts, but returns a flat object so more settings fields
// can be added later without a frontend contract change.
async function getAdminSettings(req, res) {
  try {
    const contacts = await fetchHelpContacts();
    res.json(contacts);
  } catch (err) {
    logger.error('[settings] getAdminSettings failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to load settings.' });
  }
}

// PATCH /api/admin/settings/help-contacts - authenticated admin.
async function updateHelpContacts(req, res) {
  const { helpWhatsapp, helpCall, helpEmail } = req.body || {};
  if (!helpWhatsapp || !helpCall || !helpEmail) {
    return res.status(400).json({ error: 'helpWhatsapp, helpCall, and helpEmail are all required.' });
  }

  const adminId = req.user?.id || null;
  const trimmed = {
    helpWhatsapp: String(helpWhatsapp).trim(),
    helpCall: String(helpCall).trim(),
    helpEmail: String(helpEmail).trim(),
  };

  try {
    const rows = [
      { key: HELP_KEYS.helpWhatsapp, value: trimmed.helpWhatsapp, updated_at: new Date().toISOString(), updated_by_admin_id: adminId },
      { key: HELP_KEYS.helpCall, value: trimmed.helpCall, updated_at: new Date().toISOString(), updated_by_admin_id: adminId },
      { key: HELP_KEYS.helpEmail, value: trimmed.helpEmail, updated_at: new Date().toISOString(), updated_by_admin_id: adminId },
    ];
    const { error } = await supabase.from('admin_help_contact_settings').upsert(rows, { onConflict: 'key' });
    if (error) throw error;
    res.json(trimmed);
  } catch (err) {
    logger.error('[settings] updateHelpContacts failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to save help contact details.' });
  }
}

module.exports = { getPublicHelpContacts, getAdminSettings, updateHelpContacts, fetchHelpContacts };
