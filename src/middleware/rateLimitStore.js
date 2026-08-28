// Shared store is opt-in: local development stays dependency-free, while a
// multi-replica deployment can set REDIS_URL and use the Redis adapter.
function createRateLimitStore() {
  if (!process.env.REDIS_URL) return undefined;
  try {
    const { RedisStore } = require('rate-limit-redis');
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
    client.connect().catch((err) => console.error('[rate-limit] Redis connection failed', err.message));
    return new RedisStore({ sendCommand: (...args) => client.call(...args) });
  } catch (err) {
    throw new Error('REDIS_URL is set but rate-limit-redis/ioredis are unavailable. Run npm install.');
  }
}
module.exports = { createRateLimitStore };
