// Minimal structured logger. Emits one JSON line per event so logs can be
// grepped/aggregated in production (Railway, Datadog, etc.) without giving
// up the emoji-friendly reads in dev.
//
// Use log.info('booking created', { businessId, customerId, appt: ... })
// and log.warn / log.error for the loud ones.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info
const PRETTY = process.env.LOG_FORMAT !== 'json'   // dev-friendly by default

function emit(level, msg, ctx = {}) {
  if ((LEVELS[level] || 100) < MIN) return
  if (PRETTY) {
    const prefix = { debug: '·', info: 'ℹ️', warn: '⚠️', error: '❌' }[level] || '·'
    const suffix = Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : ''
    console.log(`${prefix} ${msg}${suffix}`)
    return
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx }))
}

export const log = {
  debug: (m, c) => emit('debug', m, c),
  info:  (m, c) => emit('info',  m, c),
  warn:  (m, c) => emit('warn',  m, c),
  error: (m, c) => emit('error', m, c),
}
