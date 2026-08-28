// src/worker.js
//
// Phase 2 - dedicated background worker process. Run this as its own
// deployable (a second process type on Render/Railway/Docker/Kubernetes)
// so PDF/CSV/ZIP generation and any future queued work never competes
// with request handling on the API process.
//
//   npm run worker        (or: node src/worker.js)
//
// Requires DATABASE_URL (or SUPABASE_DB_URL) - the same app runs with
// the queue disabled (and synchronous exports as fallback) if it is
// absent.

require('dotenv').config();
const { initSentry } = require('./services/sentry.service');
const { startExportWorker } = require('./workers/export.worker');
const { shutdownQueue } = require('./services/jobQueue.service');
const logger = require('./utils/logger');

initSentry();

process.on('unhandledRejection', (reason) => {
  logger.error('[worker] UNHANDLED REJECTION (recovered, process kept alive)', reason instanceof Error ? reason : { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('[worker] UNCAUGHT EXCEPTION (exiting for a clean restart)', err);
  process.exit(1);
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[worker] ${signal} received; stopping queue consumption.`);
  const forceExit = setTimeout(() => {
    logger.error('[worker] Graceful shutdown timed out; forcing exit.');
    process.exit(1);
  }, 15000);
  forceExit.unref();
  await shutdownQueue();
  clearTimeout(forceExit);
  process.exit(0);
}
process.once('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.once('SIGINT', () => { gracefulShutdown('SIGINT'); });

(async () => {
  try {
    await startExportWorker();
    logger.info('[worker] RentaPay worker started');
  } catch (err) {
    logger.error('[worker] failed to start (is DATABASE_URL / SUPABASE_DB_URL set?)', err);
    process.exit(1);
  }
})();
