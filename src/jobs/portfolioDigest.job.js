// src/jobs/portfolioDigest.job.js
//
// FEATURE (direct request #5 - portfolio health digest): a scheduled
// per-landlord summary - occupancy rate, collection rate this period,
// top 3 late payers, and vacant units with no photos (ties into #1,
// the missing-photos nudge).
//
// UPDATED (requirements spec item #14 - "monthly cadence, in-app only,
// no email"): this job used to run on two schedules (monthly full
// digest + a lighter weekly version) and delivered by email via
// email.service.js. Per the direct request:
//   - the weekly schedule is removed entirely - monthly (06:00 on the
//     1st of each month) is now the only cadence.
//   - delivery no longer emails the landlord at all. It now routes
//     through the shared notify.service.js helper instead, the same
//     one every other in-app notification in the codebase uses, which
//     writes a row into the landlord's notifications inbox (and fires
//     a push notification) and does NOT send an email unless a caller
//     explicitly opts in with `allowEmail: true` - this call site
//     deliberately does not, so the summary is in-app only.
//
// Registers every run (success or failure) with system_heartbeats -
// same convention as the other cron jobs in this codebase (see
// baStaleApplicationReminder.job.js) - so a silent failure here is
// discoverable rather than found a month later when a landlord asks
// why they never got a summary.

const cron = require('node-cron');
const supabase = require('../config/supabase');
const { notify } = require('../services/notify.service');
const templates = require('../services/notificationTemplates');
const { runInBatches } = require('../utils/concurrency');
const { captureException } = require('../services/sentry.service');
const logger = require('../utils/logger');

const JOB_NAME = 'portfolio_digest';

async function recordHeartbeat(status, errorMessage, startedAt) {
  try {
    await supabase.from('system_heartbeats').upsert(
      {
        job_name: JOB_NAME,
        last_run_at: new Date().toISOString(),
        last_status: status,
        last_error: errorMessage || null,
        last_duration_ms: Date.now() - startedAt,
      },
      { onConflict: 'job_name' }
    );
  } catch (hbErr) {
    // Heartbeat itself failing is logged but never allowed to mask
    // or interrupt the actual digest run.
    logger.error('[cron] portfolioDigest: heartbeat write failed:', hbErr.message);
  }
}

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

async function runDigest() {
  const startedAt = Date.now();
  const period = 'monthly';
  logger.info('[cron] Running portfolio monthly digest...', new Date().toISOString());

  const { data: landlords, error } = await supabase
    .from('landlords')
    .select('id, full_name, email, portfolio_digest_enabled, subscription_status')
    .eq('is_verified', true)
    .eq('portfolio_digest_enabled', true)
    // FEATURE (direct request - strict subscription tiers): "services"
    // like the portfolio digest are blocked while a landlord's
    // subscription is lapsed. They can still log in and use the app;
    // they just stop receiving proactive updates until any of the
    // landlord/manager/caretaker renews.
    .neq('subscription_status', 'expired');

  if (error) {
    logger.error('[cron] portfolioDigest: failed to fetch landlords:', error.message);
    captureException(error);
    await recordHeartbeat('error', error.message, startedAt);
    return;
  }

  let failureCount = 0;

  await runInBatches(
    landlords || [],
    async (landlord) => {
      const stats = await buildLandlordDigest(landlord.id);
      // Skip sending an empty digest to a brand-new landlord with no
      // units yet - nothing useful to report.
      if (stats.totalUnits === 0) return;

      const { subject, body } = templates.portfolioDigestEmail(landlord.full_name, stats, period);
      // In-app only (requirements spec item #14): notify() writes to
      // the landlord's notifications inbox + push, and - because
      // allowEmail is left unset (defaults to false) - never emails
      // the summary.
      await notify('landlord', landlord.id, null, body, {
        title: subject,
        category: 'account',
        urgent: false,
      });
    },
    {
      concurrency: 5,
      onError: (err, landlord) => {
        failureCount += 1;
        logger.error(`[cron] portfolioDigest: failed for landlord ${landlord.id}:`, err.message);
        captureException(err);
      },
    }
  );

  logger.info('[cron] Portfolio monthly digest complete.');
  await recordHeartbeat(failureCount === 0 ? 'ok' : 'error', failureCount ? `${failureCount} landlord(s) failed` : null, startedAt);
}

function startPortfolioDigestJob() {
  // Monthly only (requirements spec item #14 - the weekly cadence has
  // been removed): full digest, 06:00 on the 1st of each month.
  cron.schedule('0 6 1 * *', () => runDigest());
  logger.info('[cron] Portfolio digest job scheduled (monthly 1st 06:00, in-app only).');
}

module.exports = { startPortfolioDigestJob, runDigest, buildLandlordDigest };
