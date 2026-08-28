const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const LOCK_TTL_MS = Number(process.env.CRON_LOCK_TTL_MS || 10 * 60 * 1000);

function keyForJob(name) {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${name}:${Math.abs(hash)}`;
}

async function withCronLock(name, work) {
  const lockKey = keyForJob(name);
  const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  const { data: acquired, error } = await supabase.rpc('acquire_cron_job_lock', {
    p_job_key: lockKey,
    p_owner: owner,
    p_expires_at: expiresAt,
  });
  if (error) {
    logger.error(`[cron] ${name}: lock acquisition failed; skipping run`, error);
    return;
  }
  if (!acquired) {
    logger.debug(`[cron] ${name}: another instance owns the lock; skipping run`);
    return;
  }
  try {
    return await work();
  } finally {
    const { error: releaseError } = await supabase.rpc('release_cron_job_lock', {
      p_job_key: lockKey,
      p_owner: owner,
    });
    if (releaseError) logger.warn(`[cron] ${name}: failed to release lock`, releaseError);
  }
}

module.exports = { withCronLock };
