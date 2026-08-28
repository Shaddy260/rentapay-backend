// src/services/platformPaymentSettings.service.js
//
// Backs the admin-editable Paybill/Till the platform receives landlord
// subscription payments on, replacing the values that used to be
// hardcoded in src/constants/platformPaybill.js. See
// sql/2026-08-platform-subscription-payment-settings.sql.
//
// Same short-TTL-cache pattern as subscriptionPricing.service.js -
// this is read on every "pay manually" screen render, but an admin
// change should show up within seconds, not require a redeploy or a
// restart.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');

// Fallback only if the settings row is somehow missing entirely
// (e.g. migration hasn't run yet) - mirrors the old hardcoded
// constants so a landlord is never shown a blank payment screen.
const FALLBACK_SETTINGS = {
  method: 'paybill',
  paybill_number: '522522',
  account_number: '1341657388',
  till_number: null,
  note: null,
  updated_at: null,
};

let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 15_000;

function invalidateCache() {
  cache = null;
  cacheAt = 0;
}

async function getCurrentPaymentSettings() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;

  const { data, error } = await supabase.from('platform_payment_settings').select('*').eq('id', 'current').maybeSingle();

  if (error) {
    logger.error('[platformPaymentSettings] failed to load settings, using fallback:', error.message);
    return FALLBACK_SETTINGS;
  }

  const settings = data || FALLBACK_SETTINGS;
  cache = settings;
  cacheAt = Date.now();
  return settings;
}

function validatePaymentSettingsPayload(body) {
  const method = body.method;
  if (!['paybill', 'till'].includes(method)) {
    return { error: 'method must be "paybill" or "till".' };
  }

  if (method === 'paybill') {
    const paybillNumber = String(body.paybillNumber || '').trim();
    if (!paybillNumber) return { error: 'paybillNumber is required for the paybill method.' };
    return { method, paybillNumber, accountNumber: String(body.accountNumber || '').trim() || null, tillNumber: null };
  }

  const tillNumber = String(body.tillNumber || '').trim();
  if (!tillNumber) return { error: 'tillNumber is required for the till method.' };
  return { method, tillNumber, paybillNumber: null, accountNumber: null };
}

/**
 * Overwrites the single current row and records the previous value
 * in the history table for audit purposes.
 */
async function setPaymentSettings({ method, paybillNumber, accountNumber, tillNumber, adminId, note }) {
  const previous = await getCurrentPaymentSettings();

  if (previous && previous.updated_at) {
    await supabase.from('platform_payment_settings_history').insert({
      method: previous.method,
      paybill_number: previous.paybill_number,
      account_number: previous.account_number,
      till_number: previous.till_number,
      note: previous.note,
      changed_at: previous.updated_at,
      changed_by_admin_id: previous.updated_by_admin_id || null,
    });
  }

  const row = {
    id: 'current',
    method,
    paybill_number: paybillNumber || null,
    account_number: accountNumber || null,
    till_number: tillNumber || null,
    note: note || null,
    updated_at: new Date().toISOString(),
    updated_by_admin_id: adminId || 'super-admin',
  };

  const { data: saved, error } = await supabase.from('platform_payment_settings').upsert(row, { onConflict: 'id' }).select().single();
  if (error) throw error;

  invalidateCache();
  return { saved, previous };
}

async function getPaymentSettingsHistory() {
  const { data, error } = await supabase
    .from('platform_payment_settings_history')
    .select('*')
    .order('changed_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}

module.exports = {
  getCurrentPaymentSettings,
  validatePaymentSettingsPayload,
  setPaymentSettings,
  getPaymentSettingsHistory,
  invalidateCache,
};
