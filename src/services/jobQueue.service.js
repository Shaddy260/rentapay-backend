// src/services/jobQueue.service.js
//
// Phase 2 - pg-boss backed job queue. pg-boss persists its queue to the
// SAME Postgres database the app already uses (it creates its own
// `pgboss` schema on first start - no migration needed for the queue
// itself). We use it for durable export jobs; the app-level export
// metadata lives in the export_jobs table (see
// sql/2026-08-phase2-async-exports-and-validation.sql).
//
// The API process uses this ONLY to SEND jobs. A separate worker process
// (src/worker.js) consumes them - see src/workers/export.worker.js.
//
// REQUIREMENT: pg-boss needs a direct Postgres connection string, which
// the service-role Supabase client does not provide (it speaks
// PostgREST). Set DATABASE_URL (or SUPABASE_DB_URL) to the Supabase
// Postgres connection string (the pooler-compatible one if your plan
// recommends it). Without it the queue is disabled, async export
// endpoints return 503, and the old synchronous export routes keep
// working as a fallback.

const logger = require('../utils/logger');

const QUEUE_NAME = process.env.EXPORT_JOBS_QUEUE || 'rentapay-exports';

let boss = null;
let startPromise = null;

function connectionString() {
  return process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
}

function isQueueEnabled() {
  return Boolean(connectionString());
}

async function getBoss() {
  if (boss) return boss;
  if (startPromise) return startPromise;
  const connection = connectionString();
  if (!connection) return null;

  startPromise = (async () => {
    const PgBoss = require('pg-boss');
    const instance = new PgBoss(connection, { application_name: 'rentapay-job-queue' });
    await instance.start();
    try {
      await instance.createQueue(QUEUE_NAME);
    } catch (queueErr) {
      logger.warn('[jobQueue] createQueue skipped (queue may already exist)', queueErr.message);
    }
    boss = instance;
    logger.info('[jobQueue] pg-boss started, queue ready', { queue: QUEUE_NAME });
    return boss;
  })();

  try {
    return await startPromise;
  } catch (err) {
    logger.error('[jobQueue] pg-boss failed to start; queue disabled', err);
    startPromise = null;
    return null;
  }
}

async function enqueueExport(jobType, payload, options = {}) {
  const instance = await getBoss();
  if (!instance) return null;
  try {
    return await instance.send(
      QUEUE_NAME,
      { type: jobType, payload },
      { retryLimit: 0, ...options }
    );
  } catch (err) {
    logger.error('[jobQueue] send failed', err);
    return null;
  }
}

async function shutdownQueue() {
  if (boss) {
    try {
      await boss.stop({ graceful: true, timeout: 15000 });
    } catch (err) {
      logger.warn('[jobQueue] stop error', err);
    }
    boss = null;
  }
}

module.exports = { QUEUE_NAME, getBoss, enqueueExport, isQueueEnabled, shutdownQueue };
