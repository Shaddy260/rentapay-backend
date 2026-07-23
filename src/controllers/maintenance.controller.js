const supabase = require('../config/supabase');
const { effectiveLandlordId, getManagerAssignedPropertyIds, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
const { logActivity } = require('../services/activityLog.service');
const { notify } = require('../services/notify.service');

// ---------------------------------------------------------------------
// TENANT: submit a maintenance/repair issue for their own unit.
// ---------------------------------------------------------------------
async function submitMaintenanceRequest(req, res) {
  try {
    const { title, description, photoUrl } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required.' });

    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id, full_name, unit_id, landlord_id, units(property_id, unit_name)')
      .eq('id', req.user.id)
      .single();
    if (tenantError || !tenant) return res.status(404).json({ error: 'Tenant record not found.' });

    const { data: request, error } = await supabase
      .from('maintenance_requests')
      .insert({
        tenant_id: tenant.id,
        unit_id: tenant.unit_id,
        property_id: tenant.units?.property_id || null,
        landlord_id: tenant.landlord_id,
        title,
        description: description || null,
        photo_url: photoUrl || null,
      })
      .select()
      .single();
    if (error) throw error;

    const { data: landlord } = await supabase.from('landlords').select('phone').eq('id', tenant.landlord_id).maybeSingle();
    if (landlord?.phone) {
      notify('landlord', tenant.landlord_id, landlord.phone, `${tenant.full_name} (${tenant.units?.unit_name || 'their unit'}) reported: ${title}`, {
        category: 'general',
        title: 'New maintenance report',
        propertyId: tenant.units?.property_id || null,
      }).catch(() => {});
    }

    logActivity({ actorType: 'tenant', actorId: tenant.id, action: 'maintenance_request_submitted', targetType: 'unit', targetId: tenant.unit_id, metadata: { title } });

    return res.status(201).json({ message: 'Reported. Your landlord/caretaker has been notified.', request });
  } catch (err) {
    console.error('[maintenance] submitMaintenanceRequest error:', err.message);
    return res.status(500).json({ error: 'Failed to submit maintenance request.' });
  }
}

// TENANT: their own request history.
async function listMyMaintenanceRequests(req, res) {
  try {
    const { data: requests, error } = await supabase
      .from('maintenance_requests')
      .select('*')
      .eq('tenant_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ requests: requests || [] });
  } catch (err) {
    console.error('[maintenance] listMyMaintenanceRequests error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch maintenance requests.' });
  }
}

// LANDLORD/MANAGER/CARETAKER: requests for properties they manage.
// Caretakers CAN see and act on these (unlike deposits/balances) -
// fixing things is literally what the role exists for.
async function listMaintenanceRequests(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const isManager = req.user.role === 'manager';
    const { propertyId, status } = req.query;

    let query = supabase
      .from('maintenance_requests')
      .select('*, tenants(full_name, primary_phone), units(unit_name)')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: false });

    if (isManager) {
      const assignedPropertyIds = await getManagerAssignedPropertyIds(req.user.id);
      if (assignedPropertyIds.length > 0) query = query.in('property_id', assignedPropertyIds);
    }
    if (propertyId) query = query.eq('property_id', propertyId);
    if (status) query = query.eq('status', status);

    const { data: requests, error } = await query;
    if (error) throw error;
    return res.json({ requests: requests || [] });
  } catch (err) {
    console.error('[maintenance] listMaintenanceRequests error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch maintenance requests.' });
  }
}

// LANDLORD/MANAGER/CARETAKER: move a ticket to in_progress or resolved.
async function updateMaintenanceStatus(req, res) {
  try {
    const { requestId } = req.params;
    const { status, resolutionNote } = req.body;
    if (!['open', 'in_progress', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'status must be open, in_progress, or resolved.' });
    }

    const landlordId = effectiveLandlordId(req);
    const { data: existing, error: fetchError } = await supabase.from('maintenance_requests').select('id, landlord_id, tenant_id, title, property_id').eq('id', requestId).single();
    if (fetchError || !existing) return res.status(404).json({ error: 'Maintenance request not found.' });
    if (existing.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this property.' });
    const propertyAccessError = await checkManagerPropertyAccess(req, existing.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const updates = { status, updated_at: new Date().toISOString() };
    if (status === 'resolved') {
      updates.resolved_at = new Date().toISOString();
      updates.resolution_note = resolutionNote || null;
      updates.resolved_by_type = req.user.role;
      updates.resolved_by_id = req.user.id;
    }

    const { data: updated, error } = await supabase.from('maintenance_requests').update(updates).eq('id', requestId).select().single();
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'maintenance_request_status_updated', targetType: 'maintenance_request', targetId: requestId, metadata: { status } });

    return res.json({ message: 'Updated.', request: updated });
  } catch (err) {
    console.error('[maintenance] updateMaintenanceStatus error:', err.message);
    return res.status(500).json({ error: 'Failed to update maintenance request.' });
  }
}

module.exports = { submitMaintenanceRequest, listMyMaintenanceRequests, listMaintenanceRequests, updateMaintenanceStatus };
