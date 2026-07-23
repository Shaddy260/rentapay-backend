const supabase = require('../config/supabase');
const { effectiveLandlordId } = require('../middleware/auth.middleware');

const ROLE_TABLE = { landlord: 'landlords', tenant: 'tenants', manager: 'property_managers', caretaker: 'property_managers' };

async function attachLivePhotos(rows) {
  const idsByTable = {};
  for (const row of rows) {
    const table = ROLE_TABLE[row.role];
    if (!table) continue;
    idsByTable[table] = idsByTable[table] || new Set();
    idsByTable[table].add(row.account_id);
  }
  const photoByAccountId = {};
  await Promise.all(
    Object.entries(idsByTable).map(async ([table, idSet]) => {
      const { data: accounts } = await supabase.from(table).select('id, photo_url').in('id', Array.from(idSet));
      for (const acc of accounts || []) photoByAccountId[acc.id] = acc.photo_url || null;
    })
  );
  return rows.map((row) => ({ ...row, photo_url: photoByAccountId[row.account_id] || null }));
}

// ---------------------------------------------------------------------
// FIRST-TIME CREDENTIALS (direct request - see
// sql/add-first-time-credentials.sql for the full reasoning, updated
// per a later direct request narrowing exactly who sees what):
//   - Landlord: sees tenant, manager, AND caretaker rows (?role=...
//     narrows to one; omit for all three).
//   - Full manager (role_level='manager'): ONLY tenant and caretaker
//     rows - never manager-level rows (including their own or another
//     manager's).
//   - Caretaker (role_level='caretaker'): ONLY ever sees tenant rows -
//     never their own, another caretaker's, or a manager's.
//
// Rows expire and get hard-deleted by jobs/otpExpiry.job.js the moment
// expires_at passes, but that job only runs once a minute - the
// `.gt('expires_at', now)` filter here means a request landing in that
// gap still never shows an already-expired row.
// ---------------------------------------------------------------------
async function listFirstTimeCredentials(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { role, search } = req.query;

    if (role && !['tenant', 'manager', 'caretaker'].includes(role)) {
      return res.status(400).json({ error: "role must be 'tenant', 'manager', or 'caretaker'." });
    }

    const isCaretaker = req.user.role === 'manager' && req.user.roleLevel === 'caretaker';
    const isFullManager = req.user.role === 'manager' && req.user.roleLevel !== 'caretaker';

    // What this requester is allowed to see at all, before any
    // further ?role= narrowing is applied.
    let allowedRoles = ['tenant', 'manager', 'caretaker']; // landlord: everything
    if (isCaretaker) allowedRoles = ['tenant'];
    else if (isFullManager) allowedRoles = ['tenant', 'caretaker']; // never 'manager'

    if (role && !allowedRoles.includes(role)) {
      // Asked for something outside what this role is allowed to see
      // (e.g. a full manager asking for ?role=manager) - rather than
      // erroring, just fall back to their full allowed set.
      return res.json({ credentials: [] });
    }

    let query = supabase
      .from('first_time_credentials')
      .select('*')
      .eq('landlord_id', landlordId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    // Search bar (direct request): find a name/phone quickly in a long
    // first-time-credentials list, same idea as the Landlords search
    // box in the admin portal.
    if (search && search.trim()) {
      query = query.or(`full_name.ilike.%${search.trim()}%,phone.ilike.%${search.trim()}%`);
    }

    query = role ? query.eq('role', role) : query.in('role', allowedRoles);

    const { data, error } = await query;
    if (error) throw error;

    const enriched = await attachLivePhotos(data || []);
    return res.json({ credentials: enriched });
  } catch (err) {
    console.error('[credentials] listFirstTimeCredentials error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch first-time credentials.' });
  }
}

// ---------------------------------------------------------------------
// ADMIN-WIDE VIEW (direct request: "all the otps and temp passwords
// for all the other parties come to admin portal as well... arrange
// them based on users - caretakers on their own, landlords on their
// own, managers on their own").
//
// Note on "landlords on their own" for THIS table specifically:
// landlords create their own password at signup - there's no
// first-time temp password/OTP handed to them by anyone else, so
// there's nothing to show for the 'landlord' role in
// first_time_credentials (it only ever holds tenant/manager/caretaker
// rows - see the check constraint in add-first-time-credentials.sql).
// Landlord password-RESET requests are a different table entirely -
// see listAllPasswordResetRequestsForAdmin below, which DOES include a
// 'landlord' group.
// ---------------------------------------------------------------------
async function listAllFirstTimeCredentialsForAdmin(req, res) {
  try {
    const { search } = req.query;

    let query = supabase
      .from('first_time_credentials')
      .select('*, landlords(full_name, estate_name)')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (search && search.trim()) {
      // Matches on name or phone so the admin can find one person in
      // a long platform-wide list, same as the landlord/manager Landlords
      // search box already does.
      query = query.or(`full_name.ilike.%${search.trim()}%,phone.ilike.%${search.trim()}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    const withNames = rows.map((row) => ({
      ...row,
      landlord_name: row.landlords?.full_name || null,
      estate_name: row.landlords?.estate_name || null,
      landlords: undefined,
    }));
    const enriched = await attachLivePhotos(withNames);

    const grouped = { tenant: [], manager: [], caretaker: [] };
    for (const row of enriched) {
      if (grouped[row.role]) grouped[row.role].push(row);
    }

    return res.json({ groups: grouped, total: enriched.length });
  } catch (err) {
    console.error('[credentials] listAllFirstTimeCredentialsForAdmin error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch platform-wide first-time credentials.' });
  }
}

// ---------------------------------------------------------------------
// PASSWORD-RESET REQUESTS (follow-up direct request: "landlords
// receive OTPs too, for password resets - those should be stored to
// the admin portal... categorized... whether it's forgot password or
// resetting passwords" - then further narrowed: "managers should only
// see first-time logins for tenants and caretakers, NOT password
// resets, and caretakers should only see first-time logins for
// tenants, NOT password resets"). Separate table from
// first_time_credentials (see add-otp-expiry-and-password-reset-log.sql).
//
// Landlord-only, full stop - neither a full manager nor a caretaker
// gets any access to this table, regardless of ?role=. Enforced at the
// route level (requireRole('landlord') only, see credentials.routes.js)
// and again here as defense in depth.
// ---------------------------------------------------------------------
async function listPasswordResetRequests(req, res) {
  try {
    if (req.user.role !== 'landlord') {
      return res.status(403).json({ error: 'Only landlords can view password-reset requests.' });
    }

    const landlordId = effectiveLandlordId(req);
    const { role, search } = req.query;

    if (role && !['tenant', 'manager', 'caretaker'].includes(role)) {
      return res.status(400).json({ error: "role must be 'tenant', 'manager', or 'caretaker'." });
    }

    let query = supabase
      .from('password_reset_requests')
      .select('*')
      .eq('landlord_id', landlordId)
      .gt('expires_at', new Date().toISOString())
      .order('requested_at', { ascending: false });

    if (search && search.trim()) {
      query = query.or(`full_name.ilike.%${search.trim()}%,phone.ilike.%${search.trim()}%`);
    }

    if (role) query = query.eq('role', role);

    const { data, error } = await query;
    if (error) throw error;

    const enriched = await attachLivePhotos(data || []);
    return res.json({ requests: enriched });
  } catch (err) {
    console.error('[credentials] listPasswordResetRequests error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch password-reset requests.' });
  }
}

async function listAllPasswordResetRequestsForAdmin(req, res) {
  try {
    const { search } = req.query;

    let query = supabase
      .from('password_reset_requests')
      .select('*, landlords(full_name, estate_name)')
      .gt('expires_at', new Date().toISOString())
      .order('requested_at', { ascending: false });

    if (search && search.trim()) {
      query = query.or(`full_name.ilike.%${search.trim()}%,phone.ilike.%${search.trim()}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    const withNames = rows.map((row) => ({
      ...row,
      // A landlord's own reset request has no "owning" landlord above
      // it, so row.landlords is null there - landlord_name falls back
      // to the landlord's own full_name in that one case.
      landlord_name: row.role === 'landlord' ? row.full_name : row.landlords?.full_name || null,
      estate_name: row.landlords?.estate_name || null,
      landlords: undefined,
    }));
    const enriched = await attachLivePhotos(withNames);

    const grouped = { landlord: [], tenant: [], manager: [], caretaker: [], scout: [] };
    for (const row of enriched) {
      if (grouped[row.role]) grouped[row.role].push(row);
    }

    return res.json({ groups: grouped, total: enriched.length });
  } catch (err) {
    console.error('[credentials] listAllPasswordResetRequestsForAdmin error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch platform-wide password-reset requests.' });
  }
}

module.exports = {
  listFirstTimeCredentials,
  listAllFirstTimeCredentialsForAdmin,
  listPasswordResetRequests,
  listAllPasswordResetRequestsForAdmin,
};
