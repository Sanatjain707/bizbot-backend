import 'dotenv/config'
import express from 'express'
import { whatsappRouter } from './routes/whatsapp.js'
import { dashboardRouter } from './routes/dashboard.js'
import { paymentsRouter } from './routes/payments.js'
import { businessRouter } from './routes/business.js'
import { authRouter } from './routes/auth.js'
import { billingRouter } from './routes/billing.js'
import { demoRouter } from './routes/demo.js'
import { broadcastRouter } from './routes/broadcast.js'
import { analyticsRouter } from './routes/analytics.js'
import { adminRouter } from './routes/admin.js'
import { requireActivePlan } from './middleware/requireActivePlan.js'
import { requireBusinessAuth } from './middleware/requireBusinessAuth.js'
import { requireAdminAuth } from './middleware/requireAdminAuth.js'
import { securityHeaders } from './middleware/securityHeaders.js'
import { startCronJobs } from './jobs/scheduler.js'
import { requestLogger } from './middleware/logger.js'
import { rateLimiter, tenantRateLimiter } from './middleware/rateLimiter.js'
import { initSentry, captureError } from './config/monitoring.js'

// Initialise error monitoring first (no-op unless SENTRY_DSN is set).
initSentry()

// An unhandled promise rejection would otherwise crash the process silently.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason)
  captureError(reason, { kind: 'unhandledRejection' })
})

const app = express()
const PORT = process.env.PORT || 3000

// Railway/Vercel/most PaaS put us behind a reverse proxy. Tell Express to
// trust ONE hop of X-Forwarded-For so req.ip returns the real client IP.
// Required by express-rate-limit — without it, it throws a validation
// error inside keyGenerator and every rate-limited request 500s. `1`
// means trust the immediate proxy only, not arbitrary upstream ones.
app.set('trust proxy', 1)

// Body-size cap — a WhatsApp webhook is well under 20kb. The bulk customer
// import route (up to 5000 rows) overrides this locally if needed. We
// capture the raw body so the WhatsApp webhook can verify x-hub-signature-256.
app.use(express.json({
  limit: '100kb',
  verify: (req, _res, buf) => { req.rawBody = buf },
}))
app.use(requestLogger)
app.use(securityHeaders)

// CORS: default open for local dev, lock to FRONTEND_URL in production.
// Multiple origins can be given as a comma-separated list. Trailing slashes
// are stripped from both sides — browsers omit them from the Origin header
// (an Origin is just scheme+host+port, no path), so a `FRONTEND_URL=...vercel.app/`
// used to silently fail-match. Now equivalent to the un-slashed form.
const stripSlash = (s) => s.replace(/\/+$/, '')
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || '*')
  .split(',').map(s => stripSlash(s.trim())).filter(Boolean)
app.use((req, res, next) => {
  const origin = req.headers.origin ? stripSlash(req.headers.origin) : ''
  const allowAny = ALLOWED_ORIGINS.includes('*')
  if (allowAny) res.header('Access-Control-Allow-Origin', '*')
  else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin)
    res.header('Vary', 'Origin')
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-business-id, Authorization, ngrok-skip-browser-warning')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

app.use('/webhook', whatsappRouter)
app.use('/api/auth',      rateLimiter, authRouter)
app.use('/api/dashboard', rateLimiter, requireBusinessAuth, tenantRateLimiter, requireActivePlan, dashboardRouter)
app.use('/api/payments',  rateLimiter, requireBusinessAuth, tenantRateLimiter, requireActivePlan, paymentsRouter)
// businessRouter applies its own per-route auth (mix of requireUserAuth and
// requireBusinessAuth). The tenant limiter still keys off x-business-id when
// present and falls back to IP for the pre-onboarding paths.
app.use('/api/business',  rateLimiter, tenantRateLimiter, businessRouter)
// billingRouter applies its own per-route auth. Webhook and callback are
// intentionally open (external POSTs from Razorpay).
app.use('/api/billing',   rateLimiter, tenantRateLimiter, billingRouter)
app.use('/api/demo',      rateLimiter, demoRouter)
app.use('/api/broadcast', rateLimiter, requireBusinessAuth, tenantRateLimiter, requireActivePlan, broadcastRouter)
app.use('/api/analytics', rateLimiter, requireBusinessAuth, tenantRateLimiter, analyticsRouter)
// Operator console — cross-tenant, gated by the ADMIN_EMAILS allowlist (not requireBusinessAuth)
app.use('/api/admin',     rateLimiter, requireAdminAuth, adminRouter)

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'BizBot', time: new Date().toISOString() }))
app.use((req, res) => res.status(404).json({ error: 'Route not found' }))
app.use((err, req, res, next) => { console.error('❌', err.message); captureError(err, { path: req.path, method: req.method }); res.status(500).json({ error: 'Internal server error' }) })

const server = app.listen(PORT, () => {
  console.log(`\n🤖 BizBot backend running on port ${PORT}`)
  console.log(`📡 Webhook:   http://localhost:${PORT}/webhook`)
  console.log(`💳 Billing:   http://localhost:${PORT}/api/billing`)
  console.log(`💚 Health:    http://localhost:${PORT}/health\n`)
  startCronJobs()
})

// Node 24 kills the process on unhandled promise rejections by default.
// One buggy route handler used to take the whole server down → Railway 502
// for every subsequent request. Log and continue instead — the failing
// request already 500'd; other traffic should keep working.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err)
})

// Graceful shutdown so in-flight requests finish and the Supabase client
// stops issuing new queries before the container is killed.
function shutdown(signal) {
  console.log(`\n${signal} received — draining requests...`)
  server.close(() => {
    console.log('server closed. bye 👋')
    process.exit(0)
  })
  // Hard-kill after 10s so a stuck request can't prevent exit.
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
