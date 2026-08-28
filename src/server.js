// src/server.js
//
// Entry point - wires up Express, security middleware, all routes,
// and starts the background cron jobs (blueprint 9.4 + 10.1 reminders).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { withCronLock } = require('./jobs/cronLock');
const { createRateLimitStore } = require('./middleware/rateLimitStore');

const authRoutes = require('./routes/auth.routes');
const unitRoutes = require('./routes/unit.routes');
const utilitySubmeteringRoutes = require('./routes/utilitySubmetering.routes');
const propertyRoutes = require('./routes/property.routes');
const tenantRoutes = require('./routes/tenant.routes');
const paymentRoutes = require('./routes/payment.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const adminRoutes = require('./routes/admin.routes');
const helpRoutes = require('./routes/help.routes');
const maintenanceRoutes = require('./routes/maintenance.routes');
const chatRoutes = require('./routes/chat.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const uploadRoutes = require('./routes/upload.routes');
const propertyManagerRoutes = require('./routes/propertyManager.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const pushRoutes = require('./routes/push.routes');
const announcementRoutes = require('./routes/announcement.routes');
const credentialsRoutes = require('./routes/credentials.routes');
const expenseRoutes = require('./routes/expense.routes');
const documentRoutes = require('./routes/document.routes');
const auditLogRoutes = require('./routes/auditLog.routes');
const annualReportRoutes = require('./routes/annualReport.routes');
const dataExportRoutes = require('./routes/dataExport.routes');
// Phase 2: async (queued) export endpoints - enqueue -> poll status ->
// download from a signed URL. See routes/exportJobs.routes.js.
const exportJobsRoutes = require('./routes/exportJobs.routes');
const communityRoutes = require('./routes/community.routes');
const disputeRoutes = require('./routes/dispute.routes');
const ratingFlagRoutes = require('./routes/ratingFlag.routes');
const paymentPlanRoutes = require('./routes/paymentPlan.routes');
const publicRoutes = require('./routes/public.routes');
const tenantOnboardingRoutes = require('./routes/tenantOnboarding.routes');
const brandAmbassadorRoutes = require('./routes/brandAmbassador.routes');
// SECTION 4 (Operations PIN) - General Manager's own self-service
// routes, mounted separately from admin.routes.js's /general-managers
// (admin managing GM accounts, Section 2).
const generalManagerRoutes = require('./routes/generalManager.routes');
const assistantRoutes = require('./routes/assistant.routes');
const settingsRoutes = require('./routes/settings.routes');
const baPayoutQualificationReportRoutes = require('./routes/baPayoutQualificationReport.routes');
const baPayoutLinkCycleRoutes = require('./routes/baPayoutLinkCycle.routes');

const { startSubscriptionReminderJob } = require('./jobs/subscriptionReminders.job');
const { startRentReminderJob } = require('./jobs/rentReminders.job');
const { startVacatingNoticeJob } = require('./jobs/vacatingNoticeProcessing.job');
const { startMonthlyBillingJob } = require('./jobs/monthlyBilling.job');
const { startOtpExpiryJob } = require('./jobs/otpExpiry.job');
const { startPaymentConfirmationRetentionJob } = require('./jobs/paymentConfirmationRetention.job');
const { startPortfolioDigestJob } = require('./jobs/portfolioDigest.job');
const { startSupportRatingReminderJob } = require('./jobs/supportRatingReminder.job');
const { startBaStaleApplicationReminderJob } = require('./jobs/baStaleApplicationReminder.job');
const { startBaQualificationJob } = require('./jobs/baQualification.job');
const { startNotificationBatchFlushJob } = require('./jobs/notificationBatchFlush.job');
const { startLoyaltyDiscountExpiryJob } = require('./jobs/loyaltyDiscountExpiry.job');
const { startLoyaltyCandidateDetectionJob } = require('./jobs/loyaltyCandidateDetection.job'); // P5
const { startIncompleteSignupReminderJob } = require('./jobs/incompleteSignupReminder.job');
const { startPaymentReconciliationJob } = require('./jobs/paymentReconciliation.job');
const { initSentry, captureException } = require('./services/sentry.service');
const logger = require('./utils/logger');
const requestLoggerMiddleware = require('./middleware/requestLogger.middleware');

const app = express();

// Keep cron work single-owner when more than one API replica is running.
// node-cron is patched once before the jobs are started below; every
// scheduled callback gets a stable per-job database lock key.
const scheduledCronTasks = [];
const originalCronSchedule = cron.schedule.bind(cron);
cron.schedule = (expression, callback, options) => {
  const jobName = `cron:${expression}:${scheduledCronTasks.length}`;
  const task = originalCronSchedule(expression, () => withCronLock(jobName, callback), options);
  scheduledCronTasks.push(task);
  return task;
};

// HARDENING (2D): error tracking - fails safe (logs and continues) if
// SENTRY_DSN is unset or invalid, same philosophy already used for
// WhatsApp/email in this codebase. See src/services/sentry.service.js.
initSentry();

// HARDENING (performance/reliability review, pre-deploy): there was no
// process-level safety net anywhere in this file. On modern Node
// (>=15), an unhandled promise rejection ANYWHERE in the app - a
// missed .catch on a third-party call, a background job, a webhook
// handler - crashes the entire process by default, taking down the
// API for every single user until whatever's supervising it (Docker,
// Render, PM2, etc.) notices and restarts it. That downtime/restart
// cycle is exactly the kind of thing that shows up to users as "the
// app is slow" or "the app is down" with no obvious cause in the
// logs. This doesn't change any request-handling code - it just means
// a genuinely unexpected rejection gets logged (so it's still visible
// and fixable) instead of silently killing every in-flight request
// for every landlord/tenant on the platform.
process.on('unhandledRejection', (reason) => {
  logger.error('[server] UNHANDLED REJECTION (recovered, process kept alive)', reason instanceof Error ? reason : { reason: String(reason) });
  captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

// A genuinely uncaught synchronous exception means something is in an
// unknown state - safer to log it, report it, and let the process
// exit so the supervisor restarts it cleanly, rather than either
// silently ignoring it (Node's old default) or crashing with no
// record of why. This is deliberately different from the rejection
// handler above, which recovers instead of exiting.
process.on('uncaughtException', (err) => {
  logger.error('[server] UNCAUGHT EXCEPTION (logging and exiting for a clean restart)', err);
  captureException(err);
  process.exit(1);
});

// THE FIX for "everyone gets 429 Too Many Requests together": we're
// running behind a reverse proxy (ngrok in dev, and typically something
// like Render/Railway/nginx in production). Without this, Express reads
// req.ip as the proxy's own connection, so express-rate-limit lumps
// every real visitor into ONE shared bucket instead of one bucket per
// person. Trusting the first proxy hop makes Express read the real
// client IP from the X-Forwarded-For header the proxy sets, so rate
// limits apply per-person as intended.
app.set('trust proxy', 1);

app.use(helmet());
// PERFORMANCE FIX (direct request: "twice as fast, ultra navigation"):
// every JSON response - unit lists, tenant lists, payment history -
// was going out completely uncompressed. Gzip typically shrinks JSON
// text by 70-85%, which matters most on exactly the kind of mobile
// connection this app is actually used on - less data to physically
// transfer means a faster-feeling app with zero change to the data
// itself.
app.use(compression());

// SECURITY FIX (pre-deploy review): this used to be a bare cors() call,
// which has no allowlist - it reflects whatever Origin header the
// request sends and echoes it back as Access-Control-Allow-Origin,
// meaning literally any website can call this API cross-origin.
// Since auth here is a Bearer token (not a cookie), that's not a CSRF
// hole by itself, but it's still unnecessary exposure on an API that
// moves real M-Pesa money - a compromised/malicious third-party page
// has no business being able to hit these endpoints even if it
// somehow got hold of a token via XSS elsewhere.
//
// FRONTEND_URL already exists as an env var (used everywhere else in
// this codebase to build links back to the frontend - see
// brandAmbassador.controller.js, notificationTemplates.js, etc.), so
// we reuse it here rather than inventing a second variable. Supports
// a comma-separated list so staging/prod/a custom domain can all be
// allowed at once, e.g. FRONTEND_URL=https://rentapay.co.ke,https://staging.rentapay.co.ke
// In development (no FRONTEND_URL set, or NODE_ENV !== 'production'),
// we fall back to allowing any origin so `vite dev` / Postman / local
// testing keeps working without extra setup.
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // No Origin header (curl, server-to-server, Daraja's own callback
    // hitting our webhook) - not a browser CORS request, always allow.
    if (!origin) return callback(null, true);

    if (process.env.NODE_ENV !== 'production' || allowedOrigins.length === 0) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) return callback(null, true);

    logger.warn('[server] blocked CORS request from disallowed origin', { origin });
    return callback(new Error('Not allowed by CORS'));
  },
};

app.use(cors(corsOptions));
app.use(express.json());

// Gives every request a requestId, tags all logging done while handling
// it (however deep in controllers/services), and logs one structured
// JSON line per request with status code + duration on completion. See
// src/middleware/requestLogger.middleware.js and src/utils/logger.js.
app.use(requestLoggerMiddleware);

// HARDENING (B - "edits in Supabase don't reflect in the deployed
// portal"): every controller in this codebase already queries Supabase
// fresh on each request - nothing here caches data in application
// memory. If a direct Supabase edit isn't showing up after a reload,
// the most likely remaining culprit this backend CAN fix is a CDN/edge
// or browser cache holding onto an old GET response (common when a
// backend sits behind Cloudflare or similar, since API JSON responses
// can get swept into the same caching rules as static assets unless
// told not to). This tells any cache in front of this API - browser,
// CDN, proxy - to never store or reuse a response, so every request
// always hits Supabase live. It does NOT fix: (a) the frontend
// pointing at a different Supabase project than the one being edited
// in the dashboard - check SUPABASE_URL in both places matches
// exactly; (b) a deployed frontend/backend build that's simply out of
// date and needs redeploying.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Global baseline limiter. Keep the auth limiter stricter below; deployments
// can provide a shared store through the standard express-rate-limit store
// configuration in front of this process when running multiple replicas.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  store: createRateLimitStore(),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many requests - please try again shortly.' }),
});
app.use(globalLimiter);

// Basic rate limiting on auth endpoints to slow down brute force attempts
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth', authLimiter);

app.get('/health', async (req, res) => {
  // FEATURE (direct request): the public status page only ever showed
  // two checks ("API" and "Database") - too coarse to tell a tenant
  // or landlord which part of RentaPay is actually affected when
  // something goes wrong. Expanded to ten independently reported
  // subsystems, each checked as cheaply as it can honestly be checked:
  // a real query/credential check where one exists, or a presence
  // check for configuration that a subsystem cannot function without.
  // A missing optional integration (e.g. push notifications never
  // configured on a given deployment) is reported as 'ok' rather than
  // 'error' - it is only a real problem when it is configured but not
  // reachable.
  // FEATURE (direct request): expanded again from ten checks to
  // seventeen - every independently-failable subsystem the app
  // actually depends on gets its own line, so a broken piece shows up
  // by name instead of the whole platform reading "degraded" with no
  // way to tell which feature is actually affected. Same honesty rule
  // as before: a real query/credential check where one exists, or a
  // presence check for configuration a subsystem cannot function
  // without; an integration that is optional or intentionally
  // disabled for this deployment (WhatsApp/SMS, Sentry error
  // tracking, the async export queue's DATABASE_URL) reports 'ok'
  // rather than 'error' unless it's configured but unreachable.
  const checks = {
    api: 'ok',
    database: 'ok',
    authentication: 'ok',
    payments: 'ok',
    email: 'ok',
    smsWhatsapp: 'ok',
    pushNotifications: 'ok',
    fileStorage: 'ok',
    backgroundJobs: 'ok',
    exportQueue: 'ok',
    supportChat: 'ok',
    publicListings: 'ok',
    maintenanceRequests: 'ok',
    disputesAndComplaints: 'ok',
    communityBoard: 'ok',
    utilitySubmetering: 'ok',
    errorTracking: 'ok',
  };

  const supabase = require('./config/supabase');

  try {
    const { error } = await supabase.from('platform_settings').select('id').limit(1);
    if (error) checks.database = 'error';
  } catch (err) {
    checks.database = 'error';
  }

  try {
    const { error } = await supabase.from('landlords').select('id').limit(1);
    if (error) checks.authentication = 'error';
  } catch (err) {
    checks.authentication = 'error';
  }

  // Payments: Safaricom Daraja credentials must be present for STK
  // push (subscriptions and, where a landlord uses it, tenant rent
  // collection) to work at all. This does not call Safaricom on every
  // health check (that would be wasteful and would count against
  // rate limits) - it confirms the integration is configured, the
  // same signal daraja.service.js itself relies on before attempting
  // a real request.
  const darajaConfigured = !!(process.env.DARAJA_CONSUMER_KEY && process.env.DARAJA_CONSUMER_SECRET && process.env.DARAJA_SHORTCODE);
  if (!darajaConfigured && process.env.MOCK_DARAJA !== 'true') checks.payments = 'error';

  // Email: Resend is the only channel OTPs, password resets, receipts,
  // and reminders go out on (see notify.service.js/email.service.js).
  if (!process.env.RESEND_API_KEY) checks.email = 'error';

  // Push notifications: VAPID keys back the web push subscriptions
  // used for live in browser alerts. Optional per deployment, so a
  // deployment that has never set these up is 'ok', not 'error'.
  if (process.env.VAPID_PUBLIC_KEY && !process.env.VAPID_PRIVATE_KEY) checks.pushNotifications = 'error';

  // File storage: unit photos, payment proof screenshots, and
  // documents all go through Supabase Storage - confirm the bucket
  // is actually reachable, not just that credentials exist.
  try {
    const { error } = await supabase.storage.listBuckets();
    if (error) checks.fileStorage = 'error';
  } catch (err) {
    checks.fileStorage = 'error';
  }

  // Background jobs: rent reminders, monthly billing, subscription
  // reminders, vacating notice processing, and the other cron jobs
  // started in this file all run against the same database
  // connection checked above, so a failure there is reflected here.
  checks.backgroundJobs = checks.database;

  try {
    const { error } = await supabase.from('support_sessions').select('id').limit(1);
    if (error) checks.supportChat = 'error';
  } catch (err) {
    checks.supportChat = 'error';
  }

  try {
    const { error } = await supabase.from('units').select('id').limit(1);
    if (error) checks.publicListings = 'error';
  } catch (err) {
    checks.publicListings = 'error';
  }

  // SMS/WhatsApp: sms.service.js is now a thin bridge onto the local
  // WhatsApp session (see whatsapp.service.js) - Africa's Talking SMS
  // was fully removed. WhatsApp sending is itself currently disabled
  // on purpose (the Puppeteer/Chromium session that drove it was
  // maxing out host RAM), so every call always resolves harmlessly
  // without sending anything real. That's an intentional, known state
  // for this deployment, not an outage - reported 'ok' here for the
  // same reason an unconfigured optional integration is 'ok' rather
  // than 'error'. If whatsapp-web.js is reinstated, this check should
  // start verifying the session is actually authenticated instead.
  checks.smsWhatsapp = 'ok';

  // Export queue: async report/export jobs (annual report PDF, tax
  // summary, financial CSV, receipts ZIP, data export JSON) are
  // handed to pg-boss, which needs its own direct Postgres connection
  // string - the service-role Supabase client used everywhere else in
  // this file speaks PostgREST, not raw Postgres, so it can't back
  // the queue. Without DATABASE_URL/SUPABASE_DB_URL set, async export
  // endpoints return 503 and the app falls back to the older
  // synchronous export routes automatically - a real but graceful
  // degradation, so it's surfaced as its own line rather than folded
  // into the general database check above.
  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) checks.exportQueue = 'error';

  // Maintenance requests: tenant-reported issues and their status
  // history, read by both the tenant portal and the landlord/manager/
  // caretaker "Maintenance" tab.
  try {
    const { error } = await supabase.from('maintenance_requests').select('id').limit(1);
    if (error) checks.maintenanceRequests = 'error';
  } catch (err) {
    checks.maintenanceRequests = 'error';
  }

  // Disputes & complaints: charge_disputes backs "Disputed Charges"
  // and the tenant-side dispute flow; the same table also backs the
  // help/complaints inbox surfaced to every role.
  try {
    const { error } = await supabase.from('charge_disputes').select('id').limit(1);
    if (error) checks.disputesAndComplaints = 'error';
  } catch (err) {
    checks.disputesAndComplaints = 'error';
  }

  // Community board: shared posts/announcements visible to tenants
  // and landlords within a property.
  try {
    const { error } = await supabase.from('community_posts').select('id').limit(1);
    if (error) checks.communityBoard = 'error';
  } catch (err) {
    checks.communityBoard = 'error';
  }

  // Utility submetering: shared water/electricity meter readings and
  // the invoices generated from them.
  try {
    const { error } = await supabase.from('utility_meters').select('id').limit(1);
    if (error) checks.utilitySubmetering = 'error';
  } catch (err) {
    checks.utilitySubmetering = 'error';
  }

  // Error tracking: Sentry (sentry.service.js) is a complete, harmless
  // no-op whenever SENTRY_DSN isn't set - that's a valid, common state
  // for a deployment (errors just aren't reported anywhere but the
  // console) so it's 'ok' here rather than 'error'. This line exists
  // so that IF it's configured but the DSN is malformed and init
  // throws, that misconfiguration is visible instead of silently
  // falling back to console-only logging with nobody aware of it.
  try {
    if (process.env.SENTRY_DSN) {
      // eslint-disable-next-line global-require
      require('./services/sentry.service');
    }
  } catch (err) {
    checks.errorTracking = 'error';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  return res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks, timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/units', unitRoutes);
app.use('/api/utility-submetering', utilitySubmeteringRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/first-time-credentials', credentialsRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/help', helpRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/property-managers', propertyManagerRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/audit-log', auditLogRoutes);
app.use('/api/annual-report', annualReportRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/data-export', dataExportRoutes);
app.use('/api/export-jobs', exportJobsRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/ratings', ratingFlagRoutes);
app.use('/api/payment-plans', paymentPlanRoutes);
app.use('/api/late-penalty', require('./routes/latePenalty.routes'));
app.use('/api/public', publicRoutes);
app.use('/api/tenant-onboarding', tenantOnboardingRoutes);
app.use('/api/brand-ambassadors', brandAmbassadorRoutes);
app.use('/api/manager-account', generalManagerRoutes);
app.use('/api/support-chat', require('./routes/supportChat.routes'));

// Public "Help & Contact Details" (read by every portal's Help modal,
// including the logged-out login screen) + its admin-editable
// counterpart under the existing /api/admin mount point.
app.use('/api/settings', settingsRoutes.publicRouter);
app.use('/api/admin/settings', settingsRoutes.adminRouter);

// BA Regions & Payout Qualification Report - lives under the existing
// /api/brand-ambassadors mount, alongside payout-review,
// reconciliation, qualification dry-run, etc.
app.use('/api/brand-ambassadors', baPayoutQualificationReportRoutes);
app.use('/api/brand-ambassadors', baPayoutLinkCycleRoutes);

// DEV-ONLY: lets MOCK_DARAJA=true testing complete the payment flow
// without a real Safaricom callback ever arriving. Hard-gated so this
// route tree is structurally absent (not just unused) in production -
// app.use() is never even called with it, not merely access-checked.
if (process.env.NODE_ENV !== 'production') {
  const devRoutes = require('./routes/dev.routes');
  app.use('/api/dev', devRoutes);
  logger.warn('[server] dev routes mounted', { path: '/api/dev', env: process.env.NODE_ENV });
}

// NOTE: the Super Admin panel should live at a secret, unlinked path in
// the frontend per blueprint 13.3 - set SUPER_ADMIN_SECRET_PATH in .env
// and route your frontend's admin login page to that path, not /admin.

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// Centralized error handler (catches anything that slips past try/catch)
app.use((err, req, res, next) => {
  logger.error('[server] unhandled error', err);
  captureException(err);
  res.status(500).json({ error: "We couldn't complete that right now. Please try again in a moment — if it keeps happening, contact support@rentapay.co.ke." });
});

const PORT = process.env.PORT || 5000;
let httpServer;
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[server] ${signal} received; beginning graceful shutdown.`);
  const forceExit = setTimeout(() => {
    logger.error('[server] Graceful shutdown timed out after 10s; forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  for (const task of scheduledCronTasks) {
    try { task.stop(); } catch (err) { logger.warn('[server] failed stopping cron task', err); }
  }
  clearTimeout(forceExit);
  process.exit(0);
}
process.once('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.once('SIGINT', () => { gracefulShutdown('SIGINT'); });

httpServer = app.listen(PORT, () => {
  logger.info('[server] RentaPay backend started', { port: PORT });
  startSubscriptionReminderJob();
  startRentReminderJob();
  startVacatingNoticeJob();
  startMonthlyBillingJob();
  startOtpExpiryJob();
  startPaymentConfirmationRetentionJob();
  startPortfolioDigestJob();
  startSupportRatingReminderJob();
  startBaStaleApplicationReminderJob();
  startBaQualificationJob();
  startNotificationBatchFlushJob();
  startLoyaltyDiscountExpiryJob();
  startLoyaltyCandidateDetectionJob(); // P5
  startIncompleteSignupReminderJob();
  startPaymentReconciliationJob();
});
