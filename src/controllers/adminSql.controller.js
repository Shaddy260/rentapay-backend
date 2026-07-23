// src/controllers/adminSql.controller.js
//
// Backs the admin panel's "SQL" tab: "I also want all things in
// supabase be shown in admin portal and any edit in admin portal
// reflects in supabase as well." Deliberately built as a
// table-by-table viewer/editor over a WHITELISTED set of tables and
// columns, not a raw SQL execution box - a single typo in a raw query
// box (an unscoped UPDATE/DELETE with no WHERE clause, for example)
// can destroy a table instantly with no undo. This gives the same
// practical outcome (see everything, edit anything, it writes straight
// to Supabase) with guardrails: password hashes and OTP codes are
// never returned even to admin, and every write logs to activity_logs
// like every other admin action in this codebase.
//
// Every route here is already behind requireRole('admin') at the
// router level (see admin.routes.js).

const supabase = require('../config/supabase');
const { logActivity } = require('../services/activityLog.service');
const { applyUnitLimitChange } = require('../utils/unitLimitEnforcement');

// Table -> columns never sent to the client (secrets), and columns
// the client can view but never write through this tool (system-
// managed fields, foreign keys that would silently orphan rows if
// hand-edited, etc.). Add a table here to expose it in the SQL tab -
// anything not listed stays invisible to this tool entirely, so a new
// table added by a future migration is opt-in, not automatically
// exposed.
const TABLES = {
  landlords: { redact: ['password_hash'], readOnly: ['id', 'created_at'] },
  property_managers: { redact: ['password_hash', 'otp_code'], readOnly: ['id', 'created_at', 'landlord_id'] },
  tenants: { redact: ['password_hash', 'otp_code'], readOnly: ['id', 'created_at', 'landlord_id', 'unit_id'] },
  properties: { redact: [], readOnly: ['id', 'created_at', 'landlord_id'] },
  units: { redact: [], readOnly: ['id', 'created_at', 'landlord_id'] },
  payments: { redact: [], readOnly: ['id', 'created_at', 'tenant_id', 'unit_id', 'landlord_id'] },
  subscription_payments: { redact: [], readOnly: ['id', 'created_at', 'landlord_id'] },
  pending_payment_confirmations: { redact: [], readOnly: ['id', 'created_at', 'tenant_id', 'unit_id', 'landlord_id'] },
  platform_settings: { redact: [], readOnly: ['id'] },
  help_requests: { redact: [], readOnly: ['id', 'created_at'] },
};

// FIX (direct request: "include a searchbar in admin sql"). The text
// columns worth matching against differ per table (a phone number on
// tenants, a transaction code on payments, and so on), so this is a
// curated list rather than every column - searching a UUID or a
// timestamp column string-wise wouldn't find anything useful anyway.
const SEARCHABLE_COLUMNS = {
  landlords: ['full_name', 'phone', 'email'],
  property_managers: ['full_name', 'phone', 'email'],
  tenants: ['full_name', 'primary_phone', 'email'],
  properties: ['name', 'location', 'county', 'manager_name', 'manager_phone'],
  units: ['unit_name', 'unit_payment_code', 'unit_type'],
  payments: ['mpesa_transaction_id', 'payment_method', 'status', 'recorded_note'],
  subscription_payments: ['mpesa_transaction_id', 'status'],
  pending_payment_confirmations: ['transaction_code', 'status'],
  platform_settings: ['key', 'value'],
  help_requests: ['name', 'phone', 'message', 'requester_type', 'status'],
};

function assertTableAllowed(table, res) {
  if (!TABLES[table]) {
    res.status(400).json({ error: `Table "${table}" is not exposed in the SQL tab.`, allowedTables: Object.keys(TABLES) });
    return false;
  }
  return true;
}

function redactRow(table, row) {
  const cfg = TABLES[table];
  if (!row || !cfg.redact.length) return row;
  const copy = { ...row };
  cfg.redact.forEach((col) => {
    if (col in copy) copy[col] = copy[col] ? '••••••••' : null;
  });
  return copy;
}

// ---------------------------------------------------------------------
// GET /api/admin/sql/tables - which tables this tool exposes
// ---------------------------------------------------------------------
async function listTables(req, res) {
  return res.json({
    tables: Object.keys(TABLES).map((name) => ({
      name,
      readOnlyColumns: TABLES[name].readOnly,
      redactedColumns: TABLES[name].redact,
      searchable: (SEARCHABLE_COLUMNS[name] || []).length > 0,
    })),
  });
}

// ---------------------------------------------------------------------
// GET /api/admin/sql/:table - paginated rows, redacted secrets
// ?limit=50&offset=0&search=text (search matches any text column loosely)
// ---------------------------------------------------------------------
async function listRows(req, res) {
  try {
    const { table } = req.params;
    if (!assertTableAllowed(table, res)) return;

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const search = (req.query.search || '').trim();

    let query = supabase.from(table).select('*', { count: 'exact' }).range(offset, offset + limit - 1).order('created_at', { ascending: false, nullsFirst: false });

    if (search && SEARCHABLE_COLUMNS[table]?.length) {
      // Escape %, _, and , so a search term can't break the ilike
      // pattern or the .or() filter's comma-separated syntax.
      const safe = search.replace(/[%_,]/g, (c) => `\\${c}`);
      query = query.or(SEARCHABLE_COLUMNS[table].map((col) => `${col}.ilike.%${safe}%`).join(','));
    }

    const { data, error, count } = await query;
    if (error) throw error;

    return res.json({ rows: (data || []).map((r) => redactRow(table, r)), total: count, limit, offset });
  } catch (err) {
    console.error('[adminSql] listRows error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch rows.', details: err.message });
  }
}

// ---------------------------------------------------------------------
// PATCH /api/admin/sql/:table/:id - update one row (id column assumed
// to be "id" - true for every table in TABLES above)
// ---------------------------------------------------------------------
async function updateRow(req, res) {
  try {
    const { table, id } = req.params;
    if (!assertTableAllowed(table, res)) return;

    const cfg = TABLES[table];
    const updates = { ...req.body };

    // Strip anything read-only/secret before it ever reaches the
    // database - a client-side bug or tampered request can't use this
    // to silently repoint a foreign key or overwrite a password hash.
    cfg.readOnly.forEach((col) => delete updates[col]);
    cfg.redact.forEach((col) => delete updates[col]);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No editable fields were provided.' });
    }

    // Read the row's current values for exactly the fields about to
    // change, so the audit log below can show a real before/after -
    // not just the names of whatever fields were touched.
    const { data: before } = await supabase.from(table).select(Object.keys(updates).join(',')).eq('id', id).single();

    const { data, error } = await supabase.from(table).update(updates).eq('id', id).select().single();
    if (error) throw error;

    // FIX ("I edited unit_limit via the SQL tab but units never froze"):
    // the dedicated subscription-edit screen and a landlord's own
    // renewal both call applyUnitLimitChange(), but this generic table
    // editor didn't - editing unit_limit here silently skipped the
    // freeze/archive-safety logic entirely. Special-cased so the SQL
    // tab can never bypass it.
    if (table === 'landlords' && 'unit_limit' in updates) {
      await applyUnitLimitChange({ landlordId: id, newLimit: Number(updates.unit_limit), actorType: 'admin', actorId: 'super-admin' });
    }
    if (table === 'properties' && 'unit_limit' in updates) {
      await applyUnitLimitChange({ propertyId: id, newLimit: Number(updates.unit_limit), actorType: 'admin', actorId: 'super-admin' });
    }

    logActivity({
      actorType: 'admin',
      actorId: 'super-admin',
      action: 'admin_sql_row_updated',
      targetType: table,
      targetId: id,
      metadata: { before: redactRow(table, before), after: redactRow(table, updates) },
      ipAddress: req.ip,
    });

    return res.json({ message: 'Row updated.', row: redactRow(table, data) });
  } catch (err) {
    console.error('[adminSql] updateRow error:', err.message);
    return res.status(500).json({ error: 'Failed to update row.', details: err.message });
  }
}

module.exports = { listTables, listRows, updateRow };
