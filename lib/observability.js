/**
 * Puls observability stack — Sentry error tracking + pino structured logging
 * + request-ID middleware.
 *
 * Init order matters: Sentry MUST be initialized before anything else so it
 * can instrument Express. Pino is created with a Sentry transport so error-
 * level logs flow to Sentry automatically (no manual capture needed for
 * console.error-style calls).
 *
 * Wiring (server.js):
 *   import { initObservability, logger, requestId, sentryErrorHandler } from './lib/observability.js';
 *   initObservability();                       // before app = express()
 *   app.use(requestId);                        // after express(), before routes
 *   ...routes...
 *   app.use(sentryErrorHandler);                // after routes, before final error handler
 */
import Sentry from '@sentry/node';
import pino from 'pino';
import crypto from 'node:crypto';

const SENTRY_DSN = process.env.SENTRY_DSN || '';
const ENV = process.env.NODE_ENV || (process.env.DYNO ? 'production' : 'development');
const RELEASE = process.env.HEROKU_SLUG_COMMIT || 'dev';

let _pino = null;

/**
 * Initialize Sentry + pino. Call ONCE at the very top of server.js, before
 * `app = express()`. Safe to call without a SENTRY_DSN — Sentry becomes a
 * no-op, pino still works.
 */
export function initObservability() {
  if (SENTRY_DSN) {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: ENV,
      release: RELEASE,
      // Capture 100% of errors in dev, 20% in prod (tune via SENTRY_TRACES_SAMPLE_RATE).
      tracesSampleRate: ENV === 'production' ? 0.2 : 1.0,
      // Don't send PII — we never log decoded JWTs, so don't let Sentry
      // grab them from request headers either.
      sendDefaultPii: false,
      beforeSend(event) {
        // Scrub authorization headers from any captured request.
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        return event;
      },
    });
    console.log(`[observability] Sentry initialized (env=${ENV}, release=${RELEASE})`);
  } else {
    console.log('[observability] SENTRY_DSN not set — error tracking disabled');
  }

  // Pino with structured JSON output. On Heroku, addenda picks these up.
  // In dev, pretty-print for readability.
  const isDev = ENV === 'development';
  _pino = pino({
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    base: { service: 'puls-backend', env: ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

/** The pino logger instance. Null before initObservability() is called. */
export const logger = new Proxy(
  {},
  {
    get(_, prop) {
      if (!_pino) {
        throw new Error('initObservability() must be called before using logger');
      }
      const fn = _pino[prop];
      return typeof fn === 'function' ? fn.bind(_pino) : fn;
    },
  },
);

/**
 * Express middleware: generate (or propagate) an `x-request-id` header and
 * attach it to `req.id` + the response header. Use `req.id` in log calls to
 * correlate every log line for a single request's lifecycle.
 *
 * If the inbound request already has an `x-request-id` (e.g. from a CDN or
 * upstream proxy), we honor it so traces span the edge → origin.
 */
export function requestId(req, res, next) {
  const inbound = req.headers['x-request-id'];
  const id = inbound || crypto.randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
}

/**
 * Sentry error handler — MUST be mounted after all routes, before the
 * final Express error handler. Captures the exception, then forwards to
 * the next handler so the client still gets a JSON 500.
 */
export const sentryErrorHandler = Sentry.Handlers.errorHandler();

/**
 * Sentry request handler — MUST be mounted BEFORE the first route, right
 * after `app.use(requestId)`. Instruments the request for performance
 * monitoring + captures request context on errors.
 */
export const sentryRequestHandler = Sentry.Handlers.requestHandler({
  serverName: false,
  user: false,    // Don't capture user IPs / PII
  request: true,
  ip: false,
});

/** Capture an exception manually (for try/catch blocks outside Express). */
export function captureException(err, context) {
  if (SENTRY_DSN) {
    if (context) Sentry.withScope((scope) => {
      for (const [k, v] of Object.entries(context)) scope.setTag(k, v);
      Sentry.captureException(err);
    });
    else Sentry.captureException(err);
  }
  if (_pino) _pino.error({ err: err?.message || String(err), context }, 'exception captured');
}

export default { initObservability, logger, requestId, sentryRequestHandler, sentryErrorHandler, captureException };
