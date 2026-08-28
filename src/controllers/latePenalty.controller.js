// src/controllers/latePenalty.controller.js
//
// Landlord/manager-facing endpoints for the late-payment penalty
// feature. One settings row PER PROPERTY/APARTMENT (Settings ->
// Finances, apartment picker) - toggling it on and entering a
// percentage for a property applies to every unit/tenant inside that
// property automatically. Plus per-tenant/per-period overrides. See
// services/latePenalty.service.js.

const { effectiveLandlordId, checkLandlordOwnership, checkManagerPropertyAccess } = require('../middleware/auth.middleware');
const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');
const svc = require('../services/latePenalty.service');
const { calculateLatePenalty } = require('../utils/latePenalty');
const supabase = require('../config/supabase');

function actorFromReq(req) {
  return { userId: req.user.id, role: req.user.role === 'manager' ? 'manager' : 'landlord' };
}

// Loads the property and checks it belongs to the caller's landlord
// account (and, for a scoped manager, that they've been assigned to
// it). Returns the property row, or null if not found/not accessible
// (a response has already been sent in the latter case).
async function loadPropertyForAccessCheck(req, res, propertyId) {
  const { data: property, error } = await supabase
    .from('properties')
    .select('id, landlord_id, name')
    .eq('id', propertyId)
    .maybeSingle();
  if (error) throw error;
  if (!property) {
    res.status(404).json({ error: 'Apartment/property not found.' });
    return null;
  }

  const ownershipError = await checkLandlordOwnership(req, property.landlord_id);
  if (ownershipError) {
    res.status(ownershipError.statusCode).json(ownershipError);
    return null;
  }
  const propertyAccessError = await checkManagerPropertyAccess(req, property.id);
  if (propertyAccessError) {
    res.status(propertyAccessError.statusCode).json(propertyAccessError);
    return null;
  }

  return property;
}

async function getSettings(req, res) {
  try {
    const { propertyId } = req.params;
    const property = await loadPropertyForAccessCheck(req, res, propertyId);
    if (!property) return;

    const settings = await svc.getSettings(propertyId);
    return res.json({ settings });
  } catch (err) {
    logger.error('[latePenalty] getSettings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load late payment penalty settings.' });
  }
}

async function updateSettings(req, res) {
  try {
    const { propertyId } = req.params;
    const property = await loadPropertyForAccessCheck(req, res, propertyId);
    if (!property) return;

    const actor = actorFromReq(req);
    const { saved, previous } = await svc.upsertSettings(propertyId, property.landlord_id, req.body, actor);

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'late_payment_penalty_settings_updated',
      targetType: 'property_penalty_settings',
      targetId: saved.id,
      ipAddress: req.ip,
      metadata: { propertyId, before: previous, after: saved },
    });

    return res.json({ settings: saved });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    logger.error('[latePenalty] updateSettings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update late payment penalty settings.' });
  }
}

// Live plain-language preview as the landlord adjusts the form -
// doesn't touch the DB, just runs the shared calculator against a
// hypothetical single-stretch scenario using whatever values are
// currently in the form (not necessarily saved yet).
async function previewSettings(req, res) {
  try {
    const { ratePercent, accrualUnit, capEnabled, capPercent, sampleAmount, periodsOverdue } = req.body;
    const amount = Number(sampleAmount) || 15000;
    const periods = Math.max(1, Number(periodsOverdue) || 5);
    const unit = accrualUnit === 'week' ? 'week' : 'day';

    const dueDate = new Date();
    const asOf = new Date(dueDate.getTime() + (unit === 'week' ? periods * 7 : periods) * 24 * 60 * 60 * 1000 + 1000);

    const result = calculateLatePenalty({
      outstandingBalance: amount,
      dueDate,
      payments: [],
      settings: {
        enabled: true,
        accrualUnit: unit,
        ratePercent: Number(ratePercent) || 0,
        capEnabled: !!capEnabled,
        capPercent: capPercent != null ? Number(capPercent) : null,
      },
      asOf,
    });

    return res.json({
      sampleAmount: amount,
      periodsOverdue: periods,
      accrualUnit: unit,
      penaltyAmount: result.penaltyAmount,
      totalDue: Math.round((amount + result.penaltyAmount) * 100) / 100,
      sentence: `A tenant who is ${periods} ${unit}${periods === 1 ? '' : 's'} late on KES ${amount.toLocaleString()} would owe a KES ${result.penaltyAmount.toLocaleString()} penalty (${Number(ratePercent) || 0}%/${unit}).`,
    });
  } catch (err) {
    logger.error('[latePenalty] previewSettings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to compute preview.' });
  }
}

// ---------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------

async function fetchTenantForAccessCheck(req, tenantId) {
  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('id, landlord_id, units(property_id)')
    .eq('id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return tenant;
}

async function listOverrides(req, res) {
  try {
    const { tenantId } = req.params;
    const tenant = await fetchTenantForAccessCheck(req, tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const ownershipError = await checkLandlordOwnership(req, tenant.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const overrides = await svc.listOverridesForTenant(tenantId);
    return res.json({ overrides });
  } catch (err) {
    logger.error('[latePenalty] listOverrides error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load overrides.' });
  }
}

async function createOverride(req, res) {
  try {
    const { tenantId } = req.params;
    const tenant = await fetchTenantForAccessCheck(req, tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

    const ownershipError = await checkLandlordOwnership(req, tenant.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, tenant.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const actor = actorFromReq(req);
    const override = await svc.createOverride({
      landlordId: tenant.landlord_id,
      tenantId,
      periodReference: req.body.periodReference,
      overrideType: req.body.overrideType,
      overrideValue: req.body.overrideValue,
      reason: req.body.reason,
      actor,
    });

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'late_payment_penalty_override_created',
      targetType: 'tenant_penalty_overrides',
      targetId: override.id,
      ipAddress: req.ip,
      metadata: { tenantId, override },
    });

    return res.status(201).json({ override });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    logger.error('[latePenalty] createOverride error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to create override.' });
  }
}

async function removeOverride(req, res) {
  try {
    const { overrideId } = req.params;
    const { data: existing, error } = await supabase
      .from('tenant_penalty_overrides')
      .select('id, landlord_id, tenant_id, tenants(units(property_id))')
      .eq('id', overrideId)
      .maybeSingle();
    if (error) throw error;
    if (!existing) return res.status(404).json({ error: 'Override not found.' });

    const ownershipError = await checkLandlordOwnership(req, existing.landlord_id);
    if (ownershipError) return res.status(ownershipError.statusCode).json(ownershipError);
    const propertyAccessError = await checkManagerPropertyAccess(req, existing.tenants?.units?.property_id);
    if (propertyAccessError) return res.status(propertyAccessError.statusCode).json(propertyAccessError);

    const actor = actorFromReq(req);
    const removed = await svc.removeOverride(overrideId, actor);

    logActivity({
      actorType: req.user.role,
      actorId: req.user.id,
      action: 'late_payment_penalty_override_removed',
      targetType: 'tenant_penalty_overrides',
      targetId: overrideId,
      ipAddress: req.ip,
      metadata: { tenantId: existing.tenant_id },
    });

    return res.json({ override: removed });
  } catch (err) {
    logger.error('[latePenalty] removeOverride error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to remove override.' });
  }
}

module.exports = {
  getSettings,
  updateSettings,
  previewSettings,
  listOverrides,
  createOverride,
  removeOverride,
};
