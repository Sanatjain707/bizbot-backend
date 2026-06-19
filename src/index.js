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
import { requireActivePlan } from './middleware/requireActivePlan.js'
import { startCronJobs } from './jobs/scheduler.js'
import { requestLogger } from './middleware/logger.js'
import { rateLimiter } from './middleware/rateLimiter.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(requestLogger)

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-business-id, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

app.use('/webhook', whatsappRouter)
app.use('/api/auth', rateLimiter, authRouter)
app.use('/api/dashboard', rateLimiter, requireActivePlan, dashboardRouter)
app.use('/api/payments', rateLimiter, requireActivePlan, paymentsRouter)
app.use('/api/business', rateLimiter, businessRouter)
app.use('/api/billing', billingRouter)
app.use('/api/demo', demoRouter)
app.use('/api/broadcast', rateLimiter, requireActivePlan, broadcastRouter)

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'BizBot', time: new Date().toISOString() }))
app.use((req, res) => res.status(404).json({ error: 'Route not found' }))
app.use((err, req, res, next) => { console.error('❌', err.message); res.status(500).json({ error: 'Internal server error' }) })

app.listen(PORT, () => {
  console.log(`\n🤖 BizBot backend running on port ${PORT}`)
  console.log(`📡 Webhook:   http://localhost:${PORT}/webhook`)
  console.log(`💳 Billing:   http://localhost:${PORT}/api/billing`)
  console.log(`💚 Health:    http://localhost:${PORT}/health\n`)
  startCronJobs()
})