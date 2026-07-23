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

const authRoutes = require('./routes/auth.routes');
const unitRoutes = require('./routes/unit.routes');
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
const scoutRoutes = require('./routes/scout.routes');

const { startSubscriptionReminderJob } = require('./jobs/subscriptionReminders.job');
const { startRentReminderJob } = require('./jobs/rentReminders.job');
const { startMonthlyBillingJob } = require('./jobs/monthlyBilling.job');
const { startOtpExpiryJob } = require('./jobs/otpExpiry.job');
const { startPaymentConfirmationRetentionJob } = require('./jobs/paymentConfirmationRetention.job');
const { startScoutSubscriptionReminderJob } = require('./jobs/scoutSubscriptionReminders.job');
const { initSentry, captureException } = require('./services/sentry.service');

const app = express();

// HARDENING (2D): error tracking - fails safe (logs and continues) if
// SENTRY_DSN is unset or invalid, same philosophy already used for
// WhatsApp/email in this codebase. See src/services/sentry.service.js.
initSentry();

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
app.use(cors());
app.use(express.json());

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

// Basic rate limiting on auth endpoints to slow down brute force attempts
// (complements the account lockout logic in auth.controller.js)
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.use('/api/auth', authLimiter);

app.get('/health', async (req, res) => {
  const checks = { api: 'ok', database: 'ok' };
  try {
    const supabase = require('./config/supabase');
    const { error } = await supabase.from('platform_settings').select('id').limit(1);
    if (error) checks.database = 'error';
  } catch (err) {
    checks.database = 'error';
  }
  const allOk = Object.values(checks).every((v) => v === 'ok');
  return res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks, timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/units', unitRoutes);
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
app.use('/api/scout', scoutRoutes);

// DEV-ONLY: lets MOCK_DARAJA=true testing complete the payment flow
// without a real Safaricom callback ever arriving. Hard-gated so this
// route tree is structurally absent (not just unused) in production -
// app.use() is never even called with it, not merely access-checked.
if (process.env.NODE_ENV !== 'production') {
  const devRoutes = require('./routes/dev.routes');
  app.use('/api/dev', devRoutes);
  console.warn('[server] Dev routes mounted at /api/dev (NODE_ENV != production). Do not deploy this build to production.');
}

// NOTE: the Super Admin panel should live at a secret, unlinked path in
// the frontend per blueprint 13.3 - set SUPER_ADMIN_SECRET_PATH in .env
// and route your frontend's admin login page to that path, not /admin.

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// Centralized error handler (catches anything that slips past try/catch)
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  captureException(err);
  res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`RentaPay backend running on port ${PORT}`);
  startSubscriptionReminderJob();
  startRentReminderJob();
  startMonthlyBillingJob();
  startOtpExpiryJob();
  startPaymentConfirmationRetentionJob();
  startScoutSubscriptionReminderJob();
});
