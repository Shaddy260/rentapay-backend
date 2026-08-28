// src/services/latePenalty.service.js
//
// Backs the PER-PROPERTY (per apartment) late-payment penalty
// settings and the per-tenant/per-period override records. See
// sql/2026-08-late-payment-penalty-per-property.sql and
// utils/latePenalty.js.
//
// Scope (direct request, this chat): a landlord toggles this on and
// sets a percentage ONCE PER PROPERTY/APARTMENT - not once per
// account, and not per unit. Whatever they set for a property applies
// automatically to every unit and tenant inside that property. Two
// properties owned by the same landlord can have completely different
// formulas (or one on, one off).

const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { calculateLatePenalty } = require('../utils/latePenalty');

const DEFAULT_SETTINGS = {
  enabled: false,
  accrual_unit: 'day',
  rate_percent: 0,
  cap_enabled: false,
  cap_percent: null,
  applies_to_utilities: false,
};

// Short in-memory cache per property, same shirt-pocket TTL pattern as
// subscriptionPricing.service.js - a landlord/manager change should
// take effect almost immediately, not sit stale for the rest of a
// session.
const cache = new Map(); // propertyId -> { data, at }
const CACHE_TTL_MS = 10_000;

function invalidate(propertyId) {
  cache.delete(propertyId);
}

async function getSettings(propertyId) {
  const cached = cache.get(propertyId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const { data, error } = await supabase
    .from('property_penalty_settings')
    .select('*')
    .eq('property_id', propertyId)
    .maybeSingle();

  if (error) {
    logger.error('[latePenalty] getSettings error:', error.message);
    throw error;
  }

  const settings = data || { property_id: propertyId, ...DEFAULT_SETTINGS };
  cache.set(propertyId, { data: settings, at: Date.now() });
  return settings;
}

function validateSettingsPayload(body) {
  const result = {};

  if (body.enabled != null) result.enabled = !!body.enabled;

  if (body.accrualUnit != null) {
    if (!['day', 'week'].includes(body.accrualUnit)) return { error: "accrualUnit must be 'day' or 'week'." };
    result.accrual_unit = body.accrualUnit;
  }

  if (body.ratePercent != null) {
    const rate = Number(body.ratePercent);
    if (!Number.isFinite(rate) || rate < 0) return { error: 'ratePercent must be a non-negative number.' };
    result.rate_percent = rate;
  }

  if (body.capEnabled != null) result.cap_enabled = !!body.capEnabled;

  if (body.capPercent != null) {
    const cap = Number(body.capPercent);
    if (!Number.isFinite(cap) || cap < 0 || cap > 100) return { error: 'capPercent must be between 0 and 100.' };
    result.cap_percent = cap;
  } else if (body.capPercent === null) {
    result.cap_percent = null;
  }

  if (body.appliesToUtilities != null) result.applies_to_utilities = !!body.appliesToUtilities;

  if (Object.keys(result).length === 0) return { error: 'No valid fields to update.' };

  return result;
}

async function upsertSettings(propertyId, landlordId, body, actor) {
  const parsed = validateSettingsPayload(body);
  if (parsed.error) throw Object.assign(new Error(parsed.error), { statusCode: 400 });

  // cap_percent required whenever cap_enabled ends up true.
  const existing = await getSettings(propertyId);
  const merged = { ...existing, ...parsed };
  if (merged.cap_enabled && merged.cap_percent == null) {
    throw Object.assign(new Error('capPercent is required when capEnabled is true.'), { statusCode: 400 });
  }

  const row = {
    property_id: propertyId,
    landlord_id: landlordId,
    enabled: !!merged.enabled,
    accrual_unit: merged.accrual_unit,
    rate_percent: merged.rate_percent,
    cap_enabled: !!merged.cap_enabled,
    cap_percent: merged.cap_enabled ? merged.cap_percent : null,
    applies_to_utilities: !!merged.applies_to_utilities,
    updated_at: new Date().toISOString(),
    updated_by_user_id: actor.userId,
    updated_by_role: actor.role,
  };

  const { data, error } = await supabase
    .from('property_penalty_settings')
    .upsert(row, { onConflict: 'property_id' })
    .select('*')
    .single();

  if (error) {
    logger.error('[latePenalty] upsertSettings error:', error.message);
    throw error;
  }

  invalidate(propertyId);
  return { saved: data, previous: existing };
}

// ---------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------

function periodReferenceFromDate(d) {
  const date = new Date(d);
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), 1)).toISOString().slice(0, 10);
}

async function getActiveOverride(tenantId, periodReference) {
  const { data, error } = await supabase
    .from('tenant_penalty_overrides')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('period_reference', periodReference)
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    logger.error('[latePenalty] getActiveOverride error:', error.message);
    throw error;
  }
  return data || null;
}

async function listOverridesForTenant(tenantId) {
  const { data, error } = await supabase
    .from('tenant_penalty_overrides')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function createOverride({ landlordId, tenantId, periodReference, overrideType, overrideValue, reason, actor }) {
  if (!['waive', 'custom_amount', 'custom_rate'].includes(overrideType)) {
    throw Object.assign(new Error("overrideType must be 'waive', 'custom_amount', or 'custom_rate'."), { statusCode: 400 });
  }
  if (overrideType !== 'waive' && (overrideValue == null || Number.isNaN(Number(overrideValue)) || Number(overrideValue) < 0)) {
    throw Object.assign(new Error('overrideValue must be a non-negative number for this override type.'), { statusCode: 400 });
  }
  if (!reason || !reason.trim()) {
    throw Object.assign(new Error('A reason is required for every override.'), { statusCode: 400 });
  }

  const period = periodReferenceFromDate(periodReference || new Date());

  // Superseding, not overwriting: deactivate any existing active
  // override for this tenant/period first, keeping it in the table
  // for the audit trail (see uq_tenant_penalty_overrides_active_period).
  const existing = await getActiveOverride(tenantId, period);
  if (existing) {
    const { error: deactivateError } = await supabase
      .from('tenant_penalty_overrides')
      .update({ is_active: false, removed_by_user_id: actor.userId, removed_by_role: actor.role, removed_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (deactivateError) throw deactivateError;
  }

  const { data, error } = await supabase
    .from('tenant_penalty_overrides')
    .insert({
      landlord_id: landlordId,
      tenant_id: tenantId,
      period_reference: period,
      override_type: overrideType,
      override_value: overrideType === 'waive' ? null : Number(overrideValue),
      reason: reason.trim(),
      applied_by_user_id: actor.userId,
      applied_by_role: actor.role,
    })
    .select('*')
    .single();

  if (error) {
    logger.error('[latePenalty] createOverride error:', error.message);
    throw error;
  }
  return data;
}

async function removeOverride(overrideId, actor) {
  const { data, error } = await supabase
    .from('tenant_penalty_overrides')
    .update({ is_active: false, removed_by_user_id: actor.userId, removed_by_role: actor.role, removed_at: new Date().toISOString() })
    .eq('id', overrideId)
    .select('*')
    .single();
  if (error) {
    logger.error('[latePenalty] removeOverride error:', error.message);
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------------
// Convenience: compute the live penalty for one tenant, given their
// current outstanding balance / due date / relevant payments. This is
// the function every "amount due" call site should use - it fetches
// the tenant's PROPERTY's settings (not a landlord-wide setting) plus
// any active per-tenant override, so callers don't have to.
// ---------------------------------------------------------------------
async function computePenaltyForTenant({ propertyId, tenantId, outstandingBalance, dueDate, payments, asOf, isUtilityCharge = false }) {
  const settings = await getSettings(propertyId);
  if (!settings.enabled) {
    return calculateLatePenalty({ outstandingBalance, dueDate, payments, settings: { enabled: false }, asOf });
  }
  if (isUtilityCharge && !settings.applies_to_utilities) {
    return calculateLatePenalty({ outstandingBalance, dueDate, payments, settings: { enabled: false }, asOf });
  }

  const period = periodReferenceFromDate(dueDate);
  const overrideRow = await getActiveOverride(tenantId, period);
  const override = overrideRow
    ? {
        type: overrideRow.override_type,
        value: overrideRow.override_value,
        reason: overrideRow.reason,
        appliedBy: overrideRow.applied_by_role,
        appliedAt: overrideRow.applied_at,
      }
    : null;

  return calculateLatePenalty({
    outstandingBalance,
    dueDate,
    payments,
    settings: {
      enabled: settings.enabled,
      accrualUnit: settings.accrual_unit,
      ratePercent: Number(settings.rate_percent),
      capEnabled: settings.cap_enabled,
      capPercent: settings.cap_percent != null ? Number(settings.cap_percent) : null,
    },
    override,
    asOf,
  });
}

module.exports = {
  getSettings,
  upsertSettings,
  getActiveOverride,
  listOverridesForTenant,
  createOverride,
  removeOverride,
  computePenaltyForTenant,
  periodReferenceFromDate,
  invalidate,
};
