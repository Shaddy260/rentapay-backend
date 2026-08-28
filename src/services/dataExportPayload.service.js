// src/services/dataExportPayload.service.js
//
// Phase 2 - the data-export payload builders, extracted from
// dataExport.controller.js so BOTH the synchronous download route and
// the async export worker produce byte-identical JSON. The queries and
// payload shapes are exactly what the controller used before; nothing
// about the exported data changed.

const supabase = require('../config/supabase');

async function buildLandlordExportPayload(landlordId) {
  const { data: landlord, error: landlordError } = await supabase
    .from('landlords')
    .select('id, full_name, email, phone, location, county, created_at')
    .eq('id', landlordId)
    .maybeSingle();
  if (landlordError) throw landlordError;

  const { data: properties, error: propertiesError } = await supabase
    .from('properties')
    .select('id, name, location, county, description, manager_name, manager_phone, created_at')
    .eq('landlord_id', landlordId);
  if (propertiesError) throw propertiesError;

  const { data: units, error: unitsError } = await supabase
    .from('units')
    .select('id, property_id, unit_name, unit_payment_code, unit_type, rent_amount, due_day_of_month, extra_charges, status, created_at')
    .eq('landlord_id', landlordId);
  if (unitsError) throw unitsError;

  const { data: tenants, error: tenantsError } = await supabase
    .from('tenants')
    .select('id, unit_id, full_name, primary_phone, secondary_phone, email, id_number, move_in_date, rent_override, due_day_of_month, emergency_contact_name, emergency_contact_phone, balance_due, paid_through_date, notice_given, notice_date, notice_reason, is_active, created_at')
    .eq('landlord_id', landlordId);
  if (tenantsError) throw tenantsError;

  const { data: payments, error: paymentsError } = await supabase
    .from('payments')
    .select('id, tenant_id, unit_id, amount, payment_method, mpesa_transaction_id, status, is_partial, paid_at, created_at')
    .eq('landlord_id', landlordId);
  if (paymentsError) throw paymentsError;

  const { data: expenses, error: expensesError } = await supabase
    .from('expenses')
    .select('id, property_id, category, amount, date, note, created_at')
    .eq('landlord_id', landlordId);
  if (expensesError) throw expensesError;

  const { data: maintenanceRequests, error: maintenanceError } = await supabase
    .from('maintenance_requests')
    .select('id, tenant_id, unit_id, property_id, title, description, status, resolution_note, created_at, resolved_at')
    .eq('landlord_id', landlordId);
  if (maintenanceError) throw maintenanceError;

  const { data: documents, error: documentsError } = await supabase
    .from('documents')
    .select('id, tenant_id, unit_id, property_id, label, mime_type, file_size, uploaded_at')
    .eq('landlord_id', landlordId);
  if (documentsError) throw documentsError;

  const { data: propertyManagers, error: managersError } = await supabase
    .from('property_managers')
    .select('id, full_name, phone, email, created_at')
    .eq('landlord_id', landlordId);
  // property_managers may not exist on every install's schema version;
  // don't fail the whole export over an optional table.
  const managers = managersError ? [] : (propertyManagers || []);

  return {
    exported_at: new Date().toISOString(),
    exported_by: 'RentaPay data export (self-service)',
    account: landlord || null,
    properties: properties || [],
    units: units || [],
    tenants: tenants || [],
    payments: payments || [],
    expenses: expenses || [],
    maintenance_requests: maintenanceRequests || [],
    documents: documents || [],
    property_managers: managers,
  };
}

async function buildTenantExportPayload(tenantId) {
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, full_name, primary_phone, secondary_phone, email, id_number, move_in_date, emergency_contact_name, emergency_contact_phone, balance_due, notice_given, notice_date, notice_reason, is_active, created_at, unit_id')
    .eq('id', tenantId)
    .maybeSingle();
  if (tenantError) throw tenantError;
  if (!tenant) {
    const err = new Error('Tenant account not found.');
    err.statusCode = 404;
    err.error = 'Tenant account not found.';
    throw err;
  }

  const { data: payments, error: paymentsError } = await supabase
    .from('payments')
    .select('id, amount, payment_method, mpesa_transaction_id, status, is_partial, rent_period, balance_after, paid_at, created_at')
    .eq('tenant_id', tenantId);
  if (paymentsError) throw paymentsError;

  const { data: maintenanceRequests, error: maintenanceError } = await supabase
    .from('maintenance_requests')
    .select('id, title, description, status, resolution_note, created_at, resolved_at')
    .eq('tenant_id', tenantId);
  if (maintenanceError) throw maintenanceError;

  const { data: documents, error: documentsError } = await supabase
    .from('documents')
    .select('id, label, mime_type, file_size, uploaded_at')
    .eq('tenant_id', tenantId);
  if (documentsError) throw documentsError;

  const { data: ratingsReceived, error: ratingsError } = await supabase
    .from('tenant_ratings')
    .select('id, category, rating, comment, created_at')
    .eq('tenant_email', tenant.email);
  // tenant_ratings may not exist on every install's schema version -
  // don't fail the whole export over an optional table.
  const ratings = ratingsError ? [] : (ratingsReceived || []);

  return {
    exported_at: new Date().toISOString(),
    exported_by: 'RentaPay data export (self-service)',
    account: tenant,
    payments: payments || [],
    maintenance_requests: maintenanceRequests || [],
    documents: documents || [],
    reputation_ratings_received: ratings,
  };
}

module.exports = { buildLandlordExportPayload, buildTenantExportPayload };
