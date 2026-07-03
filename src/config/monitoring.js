// Optional error monitoring via Sentry. Fully no-op unless SENTRY_DSN is set,
// so local dev and un-configured deploys are completely unaffected.
import * as Sentry from '@sentry/node'

let enabled = false

export function initSentry() {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return false
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0, // errors only — no performance tracing
  })
  enabled = true
  console.log('Sentry error monitoring enabled')
  return true
}

// Report an error. Safe to call whether or not Sentry is configured.
export function captureError(err, context = {}) {
  if (!enabled || !err) return
  try {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: context })
  } catch (_) { /* monitoring must never break the app */ }
}
