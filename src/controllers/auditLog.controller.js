// src/controllers/auditLog.controller.js
//
// Landlord/manager-facing audit trail. The activity log itself
// (activity_logs table, see activityLog.service.js) has existed for a
// while and is written to on every expense/document create-update-
// delete, but it was only ever readable from the admin panel - a
// landlord had no way to answer "who deleted this expense?" or "who
// uploaded that lease?" themselves.
//
// Scoping is done via metadata->>landlordId rather than joining back
// to the expenses/documents tables, because a delete removes the row
// those tables would need to join against - the whole point of this
// view is to still show deleted items. See expense.controller.js /
// document.controller.js: every logActivity() call for these two
// target types now carries landlordId (and propertyId, and enough of
// the record's own fields) directly in metadata for exactly this
// reason.

const supabase = require('../config/supabase');
const { effectiveLandlordId, getManagerAssignedPropertyIds } = require('../middleware/auth.middleware');

const TARGET_TYPES = ['expense', 'document'];

async function getExpenseDocumentActivity(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { propertyId, targetType, limit } = req.query;
    const isManager = req.user.role === 'manager';

    if (targetType && !TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ error: `targetType must be one of: ${TARGET_TYPES.join(', ')}.` });
    }

    let query = supabase
      .from('activity_logs')
      .select('*')
      .in('target_type', targetType ? [targetType] : TARGET_TYPES)
      .eq('metadata->>landlordId', landlordId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(limit) || 100, 500));

    if (propertyId) {
      query = query.eq('metadata->>propertyId', propertyId);
    } else if (isManager) {
      // No single property requested - a manager still only gets to
      // see activity for properties they're actually assigned to.
      const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (assignedPropertyIds.length === 0) return res.json({ logs: [] });
      query = query.in('metadata->>propertyId', assignedPropertyIds);
    }

    const { data: logs, error } = await query;
    if (error) throw error;

    // Resolve actor names (activity_logs only stores actor_type +
    // actor_id) - batch-fetch landlords and managers rather than one
    // lookup per row.
    const landlordIds = new Set();
    const managerIds = new Set();
    for (const log of logs || []) {
      if (log.actor_type === 'landlord' && log.actor_id) landlordIds.add(log.actor_id);
      if (log.actor_type === 'manager' && log.actor_id) managerIds.add(log.actor_id);
    }
    const [{ data: landlordRows }, { data: managerRows }] = await Promise.all([
      landlordIds.size ? supabase.from('landlords').select('id, full_name').in('id', [...landlordIds]) : Promise.resolve({ data: [] }),
      managerIds.size ? supabase.from('property_managers').select('id, full_name').in('id', [...managerIds]) : Promise.resolve({ data: [] }),
    ]);
    const nameById = new Map();
    (landlordRows || []).forEach((r) => nameById.set(r.id, r.full_name));
    (managerRows || []).forEach((r) => nameById.set(r.id, r.full_name));

    const enriched = (logs || []).map((log) => ({
      ...log,
      actorName: log.actor_type === 'system' ? 'System' : (nameById.get(log.actor_id) || 'Unknown user'),
    }));

    return res.json({ logs: enriched });
  } catch (err) {
    console.error('[auditLog] getExpenseDocumentActivity error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch activity log.' });
  }
}

module.exports = { getExpenseDocumentActivity };
