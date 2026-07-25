// src/controllers/document.controller.js
//
// Lease/document storage. Files live in a private Supabase Storage
// bucket ("lease-documents") - private (not public, unlike
// profile-photos) because leases and ID copies are sensitive, so
// every read goes through a short-lived signed URL instead of a
// permanent public link.
//
// ONE-TIME SETUP REQUIRED (not something SQL can do): create a
// Storage bucket named exactly "lease-documents" in the Supabase
// dashboard under Storage -> New bucket, leaving "Public bucket" OFF.

const supabase = require('../config/supabase');
const { effectiveLandlordId, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
const { logActivity } = require('../services/activityLog.service');

const BUCKET_NAME = 'lease-documents';
const SIGNED_URL_TTL_SECONDS = 60 * 10; // 10 minutes - long enough to open/download, short enough to not be a durable link

// Resolves a tenant's unit_id/property_id/landlord_id, and confirms
// (for landlord/manager callers) that the tenant belongs to them.
async function loadTenantContext(tenantId) {
  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('id, landlord_id, unit_id, units(property_id)')
    .eq('id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return tenant;
}

// LANDLORD/MANAGER: upload a document (e.g. lease) for a tenant.
async function uploadDocument(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { tenantId, label } = req.body;
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required.' });
    if (!label) return res.status(400).json({ error: 'label is required (e.g. "Lease agreement").' });
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });

    const tenant = await loadTenantContext(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
    if (tenant.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this tenant.' });
    const propertyId = tenant.units?.property_id || null;
    const accessError = await checkManagerPropertyAccess(req, propertyId);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    const extFromMime = {
      'application/pdf': 'pdf',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    };
    const ext = extFromMime[req.file.mimetype] || 'bin';
    const path = `${landlordId}/${tenantId}/${Date.now()}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${ext}`;

    const { error: uploadError } = await supabase.storage.from(BUCKET_NAME).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (uploadError) {
      if (/bucket not found/i.test(uploadError.message)) {
        return res.status(500).json({ error: 'Document storage isn\'t set up yet. In Supabase: Storage -> New bucket -> name it "lease-documents" (keep it private).' });
      }
      throw uploadError;
    }

    const { data: doc, error } = await supabase
      .from('documents')
      .insert({
        landlord_id: landlordId,
        tenant_id: tenantId,
        unit_id: tenant.unit_id,
        property_id: propertyId,
        file_path: path,
        label,
        mime_type: req.file.mimetype,
        file_size: req.file.size,
        uploaded_by_type: req.user.role,
        uploaded_by_id: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;

    logActivity({ actorType: req.user.role, actorId: req.user.id, action: 'document_uploaded', targetType: 'document', targetId: doc.id, metadata: { landlordId, propertyId, tenantId, label } });

    return res.status(201).json({ message: 'Document uploaded.', document: doc });
  } catch (err) {
    console.error('[document] uploadDocument error:', err.message);
    return res.status(500).json({ error: 'Failed to upload document.' });
  }
}

// Shared list logic - landlord/manager see everything for a tenant or
// unit they manage; a tenant sees only their own documents.
async function listDocuments(req, res) {
  try {
    const { tenantId, unitId } = req.query;
    let query = supabase.from('documents').select('*').order('uploaded_at', { ascending: false });

    if (req.user.role === 'tenant') {
      query = query.eq('tenant_id', req.user.id);
    } else {
      const landlordId = effectiveLandlordId(req);
      query = query.eq('landlord_id', landlordId);
      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (unitId) query = query.eq('unit_id', unitId);
      if (!tenantId && !unitId) {
        return res.status(400).json({ error: 'tenantId or unitId is required.' });
      }

      // Confirm the tenant/unit named actually belongs to this landlord
      // before leaking any rows, and that a manager is assigned to its
      // property.
      if (tenantId) {
        const tenant = await loadTenantContext(tenantId);
        if (!tenant || tenant.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this tenant.' });
        const accessError = await checkManagerPropertyAccess(req, tenant.units?.property_id || null);
        if (accessError) return res.status(accessError.statusCode).json(accessError);
      } else if (unitId) {
        const { data: unit } = await supabase.from('units').select('id, landlord_id, property_id').eq('id', unitId).maybeSingle();
        if (!unit || unit.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this unit.' });
        const accessError = await checkManagerPropertyAccess(req, unit.property_id);
        if (accessError) return res.status(accessError.statusCode).json(accessError);
      }
    }

    const { data: documents, error } = await query;
    if (error) throw error;

    // Attach a fresh short-lived signed URL to every row rather than
    // relying on any URL stored at upload time (which may have since
    // expired).
    const withUrls = await Promise.all(
      (documents || []).map(async (doc) => {
        const { data: signed } = await supabase.storage.from(BUCKET_NAME).createSignedUrl(doc.file_path, SIGNED_URL_TTL_SECONDS);
        return { ...doc, file_url: signed?.signedUrl || null };
      })
    );

    return res.json({ documents: withUrls });
  } catch (err) {
    console.error('[document] listDocuments error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch documents.' });
  }
}

// LANDLORD/MANAGER ONLY: delete a document. Tenants can view/download
// their own lease but never delete it (design decision flagged up
// front).
async function deleteDocument(req, res) {
  try {
    const landlordId = effectiveLandlordId(req);
    const { documentId } = req.params;

    const { data: existing, error: fetchError } = await supabase.from('documents').select('id, landlord_id, file_path, property_id, tenant_id, label').eq('id', documentId).maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) return res.status(404).json({ error: 'Document not found.' });
    if (existing.landlord_id !== landlordId) return res.status(403).json({ error: 'You do not manage this document.' });
    const accessError = await checkManagerPropertyAccess(req, existing.property_id);
    if (accessError) return res.status(accessError.statusCode).json(accessError);

    const { error: storageError } = await supabase.storage.from(BUCKET_NAME).remove([existing.file_path]);
    if (storageError) console.error('[document] failed to remove storage object:', storageError.message);

    const { error } = await supabase.from('documents').delete().eq('id', documentId);
    if (error) throw error;

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'document_deleted',
      targetType: 'document',
      targetId: documentId,
      metadata: { landlordId, propertyId: existing.property_id, tenantId: existing.tenant_id, label: existing.label },
    });

    return res.json({ message: 'Document deleted.' });
  } catch (err) {
    console.error('[document] deleteDocument error:', err.message);
    return res.status(500).json({ error: 'Failed to delete document.' });
  }
}

module.exports = { uploadDocument, listDocuments, deleteDocument };
