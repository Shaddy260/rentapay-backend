// src/middleware/requestLogger.middleware.js
//
// Assigns every incoming request a requestId, runs the rest of the
// request inside logger's AsyncLocalStorage context (so any
// logger.error/warn/info call anywhere down the stack - controllers,
// services, utils - automatically gets tagged with requestId/route,
// and userId/userRole once auth.middleware decodes the token), and logs
// a single structured line when the request completes with status
// code + duration.
//
// This is what makes "every failed login for landlord X in the last
// week" answerable: each request gets one consistent requestId that
// threads through every log line produced while handling it, and the
// final line records status/duration for that same requestId.

const crypto = require('crypto');
const logger = require('../utils/logger');

function requestLoggerMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  const startedAt = process.hrtime.bigint();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const context = {
    requestId,
    route: `${req.method} ${req.originalUrl.split('?')[0]}`,
    ip: req.ip,
  };

  logger.runWithContext(context, () => {
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : 'info';
      logger[level]('[http] request completed', {
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });
    next();
  });
}

module.exports = requestLoggerMiddleware;
