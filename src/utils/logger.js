// src/utils/logger.js
//
// STRUCTURED (JSON) LOGGING
//
// Why this exists: the codebase used to log with plain
// `console.error('[module] some message:', err.message)` strings. That's
// fine to read one-at-a-time in a terminal, but the moment you need to
// answer something like "show me every failed login for landlord X in
// the last week", a string log gives you nothing to filter on except
// grep-ing for lucky substrings.
//
// This logger keeps the exact same call sites (`logger.error(...)`,
// `logger.warn(...)`, `logger.info(...)`) but instead of printing free
// text, it always emits a single line of JSON with consistent fields:
//
//   {
//     "timestamp": "2026-07-31T10:15:00.000Z",
//     "level": "error",
//     "module": "auth",              // parsed from a leading "[auth]" tag
//     "message": "login failed",     // free-text tag stripped off
//     "requestId": "5b1e...",        // present for anything logged during a request
//     "userId": "…",                 // present once auth middleware has run
//     "userRole": "landlord",
//     "route": "POST /api/auth/login",
//     ...any extra fields (error details, ids, etc.)
//   }
//
// That means every log line is one JSON object per line ("JSON lines"),
// which is directly queryable in any log aggregator (Datadog, Better
// Stack, CloudWatch Insights, even `jq` on a raw file) - e.g.
// `jq 'select(.level=="error" and .module=="auth" and .userId=="...")'`.
//
// Call sites don't need to change how they call these functions - you
// can still do:
//   logger.error('[auth] login failed', err);
//   logger.error('[admin] deleteLandlordAccount error:', err.message);
//   logger.info('[payment] STK push initiated', { unitId, amount });
//
// Any Error instances are automatically expanded into structured
// `error: { name, message, stack }` fields instead of being flattened to
// a string. Any plain object passed in is merged into the log line as
// additional fields.

const { AsyncLocalStorage } = require('async_hooks');

// Holds per-request context (requestId, userId, userRole, route) so that
// ANY logger call made while handling a request - however deep in the
// call stack (controller -> service -> util) - automatically gets
// tagged with that request's context, with no need to pass req/res
// around manually.
const requestContext = new AsyncLocalStorage();

function runWithContext(context, fn) {
  return requestContext.run(context, fn);
}

function getContext() {
  return requestContext.getStore() || {};
}

// Merge additional context into the currently running request's store
// (e.g. once auth middleware decodes the JWT, it can attach userId/role).
function updateContext(patch) {
  const store = requestContext.getStore();
  if (store) Object.assign(store, patch);
}

const LEVELS = ['error', 'warn', 'info', 'debug'];

// Pulls a leading "[tagName] " prefix off a message string, e.g.
// "[admin] deleteLandlordAccount error:" -> { module: 'admin', message: 'deleteLandlordAccount error:' }
function extractModuleTag(message) {
  const match = /^\[([\w.-]+)\]\s*/.exec(message);
  if (!match) return { module: undefined, message };
  return { module: match[1], message: message.slice(match[0].length).trim() };
}

function serializeError(err) {
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(err.code ? { code: err.code } : {}),
  };
}

function buildLogEntry(level, args) {
  const messageParts = [];
  const meta = {};

  for (const arg of args) {
    if (arg instanceof Error) {
      meta.error = serializeError(arg);
    } else if (typeof arg === 'string') {
      messageParts.push(arg);
    } else if (arg && typeof arg === 'object') {
      // Merge plain objects/arrays directly in as extra structured fields.
      Object.assign(meta, arg);
    } else if (arg !== undefined) {
      messageParts.push(String(arg));
    }
  }

  const rawMessage = messageParts.join(' ').trim();
  const { module: mod, message } = extractModuleTag(rawMessage);

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    ...(mod ? { module: mod } : {}),
    message: message || rawMessage,
    ...getContext(),
    ...meta,
  };

  return entry;
}

function write(level, args) {
  const entry = buildLogEntry(level, args);
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const logger = {};
for (const level of LEVELS) {
  logger[level] = (...args) => write(level, args);
}
// console.log(...) call sites map to logger.info
logger.log = (...args) => write('info', args);

module.exports = {
  ...logger,
  runWithContext,
  getContext,
  updateContext,
};
