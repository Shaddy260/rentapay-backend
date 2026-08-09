// src/jobs/portfolioDigest.job.js
//
// FEATURE (direct request #5 - portfolio health digest): a scheduled
// per-landlord summary - occupancy rate, collection rate this period,
// top 3 late payers, and vacant units with no photos (ties into #1,
// the missing-photos nudge). Starts with email only, reusing the
// existing Resend-backed email.service.js/notify infrastructure -
// same reasoning as the rest of this codebase's "route everything
// through the one shared sender" convention. WhatsApp is a documented
// fast-follow, not built here, since WhatsApp sending is currently
// disabled platform-wide (see notify.service.js).
//
// Two schedules:
//   - monthly: the full digest, 06:00 on the 1st of each month.
//   - weekly: a lighter version (just the two headline rates + missing
//     photos count, no late-payer breakdown), 06:00 every Monday, so a
//     landlord isn't waiting a whole month to notice something's off.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { sendEmail, wrapEmailHtml } = require('../services/email.service');
const templates = require('../services/notificationTemplates');
const { runInBatches } = require('../utils/concurrency');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

/** Builds the digest numbers for a single landlord. */
async function buildLandlordDigest(landlordId) {
  const { data: units, error: unitsErr } = await supabase
    .from('units')
    .select('id, unit_name, status, rent_amount, photo_urls')
    .eq('landlord_id', landlordId);
  if (unitsErr) throw unitsErr;

  const totalUnits = (units || []).length;
  const occupied = (units || []).filter((u) => u.status === 'occupied' || u.status === 'notice_given').length;
  const occupancyRate = totalUnits > 0 ? Math.round((occupied / totalUnits) * 1000) / 10 : 0;

  // FEATURE (direct request #1 - missing photos nudge): same idea as
  // the dashboard banner/badge, escalated here per direct request ("3
  // of your vacant units have no photos").
  const vacantNoPhotoUnits = (units || []).filter(
    (u) => u.status === 'vacant' && (!u.photo_urls || u.photo_urls.length === 0)
  );

  const unitIds = (units || []).map((u) => u.id);
  let tenants = [];
  if (unitIds.length > 0) {
    const { data: tenantRows, error: tenantsErr } = await supabase
      .from('tenants')
      .select('id, full_name, unit_id, balance_due, is_active')
      .eq('landlord_id', landlordId)
      .eq('is_active', true)
      .in('unit_id', unitIds);
    if (tenantsErr) throw tenantsErr;
    tenants = tenantRows || [];
  }

  const unitById = new Map((units || []).map((u) => [u.id, u]));

  const today = new Date();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  let payments = [];
  if (unitIds.length > 0) {
    const { data: paymentRows, error: paymentsErr } = await supabase
      .from('payments')
      .select('amount')
      .eq('landlord_id', landlordId)
      .eq('status', 'completed')
      .in('unit_id', unitIds)
      .gte('paid_at', startOfMonth.toISOString());
    if (paymentsErr) throw paymentsErr;
    payments = paymentRows || [];
  }
  const collectedThisMonth = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const expectedThisMonth = (units || [])
    .filter((u) => u.status === 'occupied' || u.status === 'notice_given')
    .reduce((sum, u) => sum + Number(u.rent_amount || 0), 0);
  const collectionRate = expectedThisMonth > 0 ? Math.round((collectedThisMonth / expectedThisMonth) * 1000) / 10 : null;

  // Top 3 late payers, ranked by outstanding balance - matches the
  // "top 3 late payers" wording of the direct request more directly
  // than a days-overdue ranking would, since a landlord scanning a
  // digest email cares most about who owes the most right now.
  const topLatePayers = tenants
    .filter((t) => Number(t.balance_due) > 0)
    .sort((a, b) => Number(b.balance_due) - Number(a.balance_due))
    .slice(0, 3)
    .map((t) => ({
      tenantName: t.full_name,
      unitName: unitById.get(t.unit_id)?.unit_name || 'Unknown unit',
      balanceDue: Number(t.balance_due),
    }));

  return {
    totalUnits,
    occupancyRate,
    collectionRate,
    collectedThisMonth,
    expectedThisMonth,
    topLatePayers,
    vacantNoPhotoCount: vacantNoPhotoUnits.length,
    vacantNoPhotoUnitNames: vacantNoPhotoUnits.slice(0, 5).map((u) => u.unit_name),
  };
}

async function runDigest(period) {
  logger.info(`[cron] Running portfolio ${period} digest...`, new Date().toISOString());

  const { data: landlords, error } = await supabase
    .from('landlords')
    .select('id, full_name, email, portfolio_digest_enabled, subscription_status')
    .eq('is_verified', true)
    .eq('portfolio_digest_enabled', true)
    // FEATURE (direct request - strict subscription tiers): "services"
    // like the portfolio digest are blocked while a landlord's
    // subscription is lapsed. They can still log in and use the app;
    // they just stop receiving proactive email/WhatsApp updates until
    // any of the landlord/manager/caretaker renews.
    .neq('subscription_status', 'expired')
    .not('email', 'is', null);

  if (error) {
    logger.error(`[cron] portfolioDigest (${period}): failed to fetch landlords:`, error.message);
    captureException(error);
    return;
  }

  await runInBatches(
    landlords || [],
    async (landlord) => {
      const stats = await buildLandlordDigest(landlord.id);
      // Skip sending an empty digest to a brand-new landlord with no
      // units yet - nothing useful to report.
      if (stats.totalUnits === 0) return;

      const { subject, body } = templates.portfolioDigestEmail(landlord.full_name, stats, period);
      await sendEmail(landlord.email, subject, wrapEmailHtml(body));
    },
    {
      concurrency: 5,
      onError: (err, landlord) => {
        logger.error(`[cron] portfolioDigest (${period}): failed for landlord ${landlord.id}:`, err.message);
        captureException(err);
      },
    }
  );

  logger.info(`[cron] Portfolio ${period} digest complete.`);
}

function startPortfolioDigestJob() {
  // Monthly: full digest, 06:00 on the 1st.
  cron.schedule('0 6 1 * *', () => runDigest('monthly'));
  // Weekly: lighter digest, 06:00 every Monday.
  cron.schedule('0 6 * * 1', () => runDigest('weekly'));
  logger.info('[cron] Portfolio digest jobs scheduled (monthly 1st 06:00, weekly Mon 06:00).');
}

module.exports = { startPortfolioDigestJob, runDigest, buildLandlordDigest };
