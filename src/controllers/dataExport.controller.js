// src/controllers/dataExport.controller.js
//
// Direct request: a GDPR-style "export my data" for a landlord who's
// leaving (or just wants a local backup). Pulls together everything
// RentaPay holds under that landlord's account - properties, units,
// tenants, payments, expenses, maintenance requests, documents
// (metadata only, not the files themselves), announcements, and
// property managers - into a single JSON file the landlord can keep.
//
// Deliberately left OUT of the export: password hashes, OTP codes,
// OTP expiry, failed-login/lockout counters, and reset tokens for any
// account included (landlord, tenants, managers) - none of that is
// "the landlord's data" in the sense this feature is for, and shipping
// it back to the browser as a downloadable file would be a needless
// credential-leak surface for zero benefit to the landlord.
//
// This is a straight JSON download rather than a zip - no new
// dependency needed, and every modern OS/phone opens a .json file
// fine (or the landlord can just re-upload it to another tool).

const supabase = require('../config/supabase');
const { effectiveLandlordId } = require('../middleware/auth.middleware');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

async function exportMyData(req, res) {
  try {
    if (req.user.role === 'tenant') return exportTenantData(req, res);

    const landlordId = effectiveLandlordId(req);
    if (req.user.role === 'manager') {
      return res.status(403).json({ error: 'Only the landlord account owner can export account data.' });
    }

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

    const exportPayload = {
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

    const filename = `rentapay-data-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(exportPayload, null, 2));
  } catch (err) {
    logger.error('[dataExport] exportMyData error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate data export.' });
  }
}

// ---------------------------------------------------------------------
// FIX (spec item 3, "Data & account" section of the new Tenant
// Settings page): the same self-service export, scoped to a single
// tenant's own data instead of a landlord's whole portfolio - their
// own profile, their own payments, their own maintenance requests and
// document records, and their own reputation ratings. Deliberately
// does NOT include the landlord's or property's own data (rent
// amounts belong to the unit, not the tenant, but everything the
// tenant themself generated is included) - just like the landlord
// export, no password hashes, OTP codes/expiry, lockout counters, or
// reset tokens.
// ---------------------------------------------------------------------
async function exportTenantData(req, res) {
  try {
    const tenantId = req.user.id;

    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id, full_name, primary_phone, secondary_phone, email, id_number, move_in_date, emergency_contact_name, emergency_contact_phone, balance_due, notice_given, notice_date, notice_reason, is_active, created_at, unit_id')
      .eq('id', tenantId)
      .maybeSingle();
    if (tenantError) throw tenantError;
    if (!tenant) return res.status(404).json({ error: 'Tenant account not found.' });

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

    const exportPayload = {
      exported_at: new Date().toISOString(),
      exported_by: 'RentaPay data export (self-service)',
      account: tenant,
      payments: payments || [],
      maintenance_requests: maintenanceRequests || [],
      documents: documents || [],
      reputation_ratings_received: ratings,
    };

    const filename = `rentapay-my-data-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(exportPayload, null, 2));
  } catch (err) {
    logger.error('[dataExport] exportTenantData error:', err.message);
    captureException(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate data export.' });
  }
}

module.exports = { exportMyData };
