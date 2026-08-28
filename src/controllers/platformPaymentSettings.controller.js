// src/controllers/platformPaymentSettings.controller.js
//
// Strictly-admin endpoints for the Paybill/Till landlords pay their
// RentaPay subscription to - the same manual-payment destination
// shown on SubscriptionManage.jsx's "didn't receive the popup? pay
// manually" fallback (via PaymentDetailsCard.jsx). This is the
// platform's OWN receiving account, not any individual landlord's -
// compare to how a landlord sets their own payment_method (for
// collecting rent from tenants) in Settings.jsx / auth.controller.js
// updatePaymentMethod.

const { logActivity } = require('../services/activityLog.service');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');
const service = require('../services/platformPaymentSettings.service');

const ADMIN_ACTOR_ID = 'super-admin';

// PUBLIC-but-authenticated (any logged-in landlord/manager/caretaker) -
// just the method + numbers a payer needs to see, nothing admin-only
// like the change history. Powers PaymentDetailsCard.jsx wherever a
// landlord is told where to send their manual subscription payment.
async function getPayerFacingPaymentSettings(req, res) {
  try {
    const current = await service.getCurrentPaymentSettings();
    return res.json({
      method: current.method,
      paybillNumber: current.paybill_number,
      accountNumber: current.account_number,
      tillNumber: current.till_number,
    });
  } catch (err) {
    logger.error('[platformPaymentSettings] getPayerFacingPaymentSettings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load payment details.' });
  }
}

async function getPlatformPaymentSettings(req, res) {
  try {
    const [current, history] = await Promise.all([service.getCurrentPaymentSettings(), service.getPaymentSettingsHistory()]);
    return res.json({ current, history });
  } catch (err) {
    logger.error('[platformPaymentSettings] getPlatformPaymentSettings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to load the platform payment settings.' });
  }
}

async function updatePlatformPaymentSettings(req, res) {
  try {
    const parsed = service.validatePaymentSettingsPayload(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const adminId = req.user?.id || ADMIN_ACTOR_ID;

    const { saved, previous } = await service.setPaymentSettings({
      method: parsed.method,
      paybillNumber: parsed.paybillNumber,
      accountNumber: parsed.accountNumber,
      tillNumber: parsed.tillNumber,
      adminId,
      note: req.body.note,
    });

    logActivity({
      actorType: 'admin',
      actorId: adminId,
      action: 'platform_payment_settings_updated',
      targetType: 'platform_payment_settings',
      targetId: 'current',
      ipAddress: req.ip,
      metadata: { before: previous, after: saved },
    });

    return res.json({ current: saved });
  } catch (err) {
    logger.error('[platformPaymentSettings] updatePlatformPaymentSettings error:', err.message);
    captureException(err);
    return res.status(500).json({ error: 'Failed to update the platform payment settings.' });
  }
}

module.exports = {
  getPayerFacingPaymentSettings,
  getPlatformPaymentSettings,
  updatePlatformPaymentSettings,
};
