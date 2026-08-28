const cron = require('node-cron');
const supabase = require('../config/supabase');
const { querySTKPushStatus } = require('../services/daraja.service');
const { processRentPaymentCallback, processSubscriptionPaymentCallback } = require('../controllers/payment.controller');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

async function reconcilePendingPayments() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  try {
    const [{ data: rents }, { data: subscriptions }] = await Promise.all([
      supabase.from('payments').select('*, tenants(*), units(unit_name, rent_amount, property_id)').eq('status', 'pending').lt('created_at', cutoff).not('mpesa_checkout_request_id', 'is', null).limit(100),
      supabase.from('subscription_payments').select('*, landlords(*)').eq('status', 'pending').lt('created_at', cutoff).not('mpesa_checkout_request_id', 'is', null).limit(100),
    ]);
    for (const payment of rents || []) {
      try {
        const result = await querySTKPushStatus(payment.mpesa_checkout_request_id);
        const code = Number(result.ResultCode);
        if (code === 0) await processRentPaymentCallback(payment, 0, null);
        else if (!Number.isNaN(code) && code !== 1037) await supabase.from('payments').update({ status: 'failed' }).eq('id', payment.id).eq('status', 'pending');
      } catch (err) { logger.warn('[cron] paymentReconciliation rent failed', { paymentId: payment.id, error: err.message }); }
    }
    for (const payment of subscriptions || []) {
      try {
        const result = await querySTKPushStatus(payment.mpesa_checkout_request_id);
        const code = Number(result.ResultCode);
        if (code === 0) await processSubscriptionPaymentCallback(payment, 0, null);
        else if (!Number.isNaN(code) && code !== 1037) await supabase.from('subscription_payments').update({ status: 'failed' }).eq('id', payment.id).eq('status', 'pending');
      } catch (err) { logger.warn('[cron] paymentReconciliation subscription failed', { paymentId: payment.id, error: err.message }); }
    }
  } catch (err) {
    logger.error('[cron] paymentReconciliation failed', err);
    captureException(err);
  }
}

function startPaymentReconciliationJob() {
  cron.schedule('*/5 * * * *', reconcilePendingPayments);
  logger.info('[cron] Pending STK reconciliation scheduled every 5 minutes.');
}

module.exports = { startPaymentReconciliationJob, reconcilePendingPayments };
