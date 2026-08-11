// src/controllers/settings.controller.js
//
// Backs Admin > Settings > "Help & Contact Details" and every portal's
// Help modal (which reads the PUBLIC endpoint - no login required,
// since the Help button is visible on the logged-out login screen
// too).
//
// Email uses `admin_help_contact_settings` (single-row-per-key store -
// there's still only ever one support email). Call/WhatsApp numbers
// use `help_contact_numbers` (item 3: admin can add/edit/remove any
// number of call and/or WhatsApp lines - primary, backup, per-shift,
// etc - not just one fixed field each). See
// sql/2026-08-help-contact-numbers-multi.sql for the migration and
// background on why these are two different shapes.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { captureException } = require('../services/sentry.service');

const HELP_EMAIL_KEY = 'help_email';
const DEFAULT_EMAIL = 'support@rentapay.co.ke';

// Kept only as the last-resort fallback if help_contact_numbers is
// ever empty (e.g. a fresh environment where the migration hasn't
// seeded it yet) - mirrors the old hardcoded frontend constants so
// nothing regresses to "no contact number at all".
const FALLBACK_NUMBERS = [
  { id: null, label: 'Primary', type: 'whatsapp', value: '+254710888917', sortOrder: 0, isActive: true },
  { id: null, label: 'Primary', type: 'call', value: '254710888917', sortOrder: 0, isActive: true },
];

function mapNumberRow(row) {
  return {
    id: row.id,
    label: row.label || '',
    type: row.type,
    value: row.value,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

async function fetchHelpEmail() {
  const { data, error } = await supabase
    .from('admin_help_contact_settings')
    .select('value')
    .eq('key', HELP_EMAIL_KEY)
    .maybeSingle();
  if (error) throw error;
  return (data && data.value) || DEFAULT_EMAIL;
}

async function fetchHelpNumbers({ activeOnly = false } = {}) {
  let query = supabase.from('help_contact_numbers').select('*').order('type', { ascending: true }).order('sort_order', { ascending: true });
  if (activeOnly) query = query.eq('is_active', true);
  const { data, error } = await query;
  if (error) throw error;
  if (!data || data.length === 0) {
    return FALLBACK_NUMBERS;
  }
  return data.map(mapNumberRow);
}

// Back-compat single-value fields (helpWhatsapp/helpCall) alongside
// the new helpNumbers list - every existing caller (HelpButton.jsx,
// ManualPaymentHelp.jsx) that only ever showed one number each still
// works unchanged, picking the first active entry of each type as
// "the" number; newer UI can render the full helpNumbers array.
function toPublicShape(email, numbers) {
  const activeNumbers = numbers.filter((n) => n.isActive !== false);
  const firstOfType = (type) => activeNumbers.find((n) => n.type === type)?.value
    || FALLBACK_NUMBERS.find((n) => n.type === type).value;
  return {
    helpEmail: email,
    helpWhatsapp: firstOfType('whatsapp'),
    helpCall: firstOfType('call'),
    helpNumbers: activeNumbers,
  };
}

// GET /api/settings/public/help-contacts - unauthenticated.
async function getPublicHelpContacts(req, res) {
  try {
    const [email, numbers] = await Promise.all([fetchHelpEmail(), fetchHelpNumbers({ activeOnly: true })]);
    res.json(toPublicShape(email, numbers));
  } catch (err) {
    // Never fail hard here - a broken DB connection shouldn't take
    // down every Help button on the site - fall back to the same
    // defaults the frontend already assumed before this existed.
    logger.error('[settings] getPublicHelpContacts failed, returning defaults', err);
    captureException(err);
    res.json(toPublicShape(DEFAULT_EMAIL, FALLBACK_NUMBERS));
  }
}

// GET /api/admin/settings - authenticated admin. Returns email + the
// FULL numbers list (including inactive ones, so the admin can see
// and re-enable something they'd disabled) as a flat object so more
// settings fields can be added later without a frontend contract
// change.
async function getAdminSettings(req, res) {
  try {
    const [email, numbers] = await Promise.all([fetchHelpEmail(), fetchHelpNumbers({ activeOnly: false })]);
    res.json({ helpEmail: email, helpNumbers: numbers });
  } catch (err) {
    logger.error('[settings] getAdminSettings failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to load settings.' });
  }
}

// PATCH /api/admin/settings/help-contacts - authenticated admin.
// Only updates the email now - number CRUD moved to the dedicated
// endpoints below since it's a list, not a single field.
async function updateHelpContacts(req, res) {
  const { helpEmail } = req.body || {};
  if (!helpEmail) {
    return res.status(400).json({ error: 'helpEmail is required.' });
  }

  const adminId = req.user?.id || null;
  const trimmedEmail = String(helpEmail).trim();

  try {
    const { error } = await supabase.from('admin_help_contact_settings').upsert(
      [{ key: HELP_EMAIL_KEY, value: trimmedEmail, updated_at: new Date().toISOString(), updated_by_admin_id: adminId }],
      { onConflict: 'key' }
    );
    if (error) throw error;
    res.json({ helpEmail: trimmedEmail });
  } catch (err) {
    logger.error('[settings] updateHelpContacts failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to save help contact details.' });
  }
}

// GET /api/admin/settings/help-contacts/numbers - authenticated admin.
async function listHelpContactNumbers(req, res) {
  try {
    const numbers = await fetchHelpNumbers({ activeOnly: false });
    res.json({ helpNumbers: numbers });
  } catch (err) {
    logger.error('[settings] listHelpContactNumbers failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to load contact numbers.' });
  }
}

function validateTypeAndValue(type, value) {
  if (!['call', 'whatsapp'].includes(type)) {
    return 'type must be "call" or "whatsapp".';
  }
  if (!value || !String(value).trim()) {
    return 'value is required.';
  }
  return null;
}

// POST /api/admin/settings/help-contacts/numbers - authenticated admin.
// Adds a new call or WhatsApp number to the list.
async function createHelpContactNumber(req, res) {
  const { label, type, value, sortOrder, isActive } = req.body || {};
  const validationError = validateTypeAndValue(type, value);
  if (validationError) return res.status(400).json({ error: validationError });

  const adminId = req.user?.id || null;
  try {
    const { data, error } = await supabase
      .from('help_contact_numbers')
      .insert({
        label: label ? String(label).trim() : '',
        type,
        value: String(value).trim(),
        sort_order: Number.isFinite(sortOrder) ? sortOrder : 0,
        is_active: isActive !== false,
        updated_by_admin_id: adminId,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(mapNumberRow(data));
  } catch (err) {
    logger.error('[settings] createHelpContactNumber failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to add contact number.' });
  }
}

// PATCH /api/admin/settings/help-contacts/numbers/:id - authenticated admin.
// Edits an existing number (label/type/value/sortOrder/isActive - any subset).
async function updateHelpContactNumber(req, res) {
  const { id } = req.params;
  const { label, type, value, sortOrder, isActive } = req.body || {};

  if (type !== undefined || value !== undefined) {
    const validationError = validateTypeAndValue(type, value);
    if (validationError) return res.status(400).json({ error: validationError });
  }

  const adminId = req.user?.id || null;
  const updates = { updated_at: new Date().toISOString(), updated_by_admin_id: adminId };
  if (label !== undefined) updates.label = String(label).trim();
  if (type !== undefined) updates.type = type;
  if (value !== undefined) updates.value = String(value).trim();
  if (sortOrder !== undefined) updates.sort_order = sortOrder;
  if (isActive !== undefined) updates.is_active = !!isActive;

  try {
    const { data, error } = await supabase
      .from('help_contact_numbers')
      .update(updates)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Contact number not found.' });
    res.json(mapNumberRow(data));
  } catch (err) {
    logger.error('[settings] updateHelpContactNumber failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to update contact number.' });
  }
}

// DELETE /api/admin/settings/help-contacts/numbers/:id - authenticated admin.
async function deleteHelpContactNumber(req, res) {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('help_contact_numbers').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('[settings] deleteHelpContactNumber failed', err);
    captureException(err);
    res.status(500).json({ error: 'Failed to remove contact number.' });
  }
}

module.exports = {
  getPublicHelpContacts,
  getAdminSettings,
  updateHelpContacts,
  listHelpContactNumbers,
  createHelpContactNumber,
  updateHelpContactNumber,
  deleteHelpContactNumber,
  fetchHelpEmail,
  fetchHelpNumbers,
};
