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
import { requireActivePlan } from './middleware/requireActivePlan.js'
import { requireBusinessAuth } from './middleware/requireBusinessAuth.js'
import { startCronJobs } from './jobs/scheduler.js'
import { requestLogger } from './middleware/logger.js'
import { rateLimiter } from './middleware/rateLimiter.js'

const app = express()
const PORT = process.env.PORT || 3000

// Body-size cap — a WhatsApp webhook is well under 20kb. The bulk customer
// import route (up to 5000 rows) overrides this locally if needed. We
// capture the raw body so the WhatsApp webhook can verify x-hub-signature-256.
app.use(express.json({
  limit: '100kb',
  verify: (req, _res, buf) => { req.rawBody = buf },
}))
app.use(requestLogger)

// CORS: default open for local dev, lock to FRONTEND_URL in production.
// Multiple origins can be given as a comma-separated list.
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || '*')
  .split(',').map(s => s.trim()).filter(Boolean)
app.use((req, res, next) => {
  const origin = req.headers.origin
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
app.use('/api/auth', rateLimiter, authRouter)
app.use('/api/dashboard', rateLimiter, requireBusinessAuth, requireActivePlan, dashboardRouter)
app.use('/api/payments',  rateLimiter, requireBusinessAuth, requireActivePlan, paymentsRouter)
app.use('/api/business',  rateLimiter, businessRouter)          // includes public /by-user and /create paths
app.use('/api/billing',   billingRouter)
app.use('/api/demo',      demoRouter)
app.use('/api/broadcast', rateLimiter, requireBusinessAuth, requireActivePlan, broadcastRouter)
app.use('/api/analytics', rateLimiter, requireBusinessAuth, analyticsRouter)

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'BizBot', time: new Date().toISOString() }))
app.use((req, res) => res.status(404).json({ error: 'Route not found' }))
app.use((err, req, res, next) => { console.error('❌', err.message); res.status(500).json({ error: 'Internal server error' }) })

const server = app.listen(PORT, () => {
  console.log(`\n🤖 BizBot backend running on port ${PORT}`)
  console.log(`📡 Webhook:   http://localhost:${PORT}/webhook`)
  console.log(`💳 Billing:   http://localhost:${PORT}/api/billing`)
  console.log(`💚 Health:    http://localhost:${PORT}/health\n`)
  startCronJobs()
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
