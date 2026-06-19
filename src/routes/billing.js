import { Router } from 'express'
import { PLANS, createPaymentLink, createSubscription, verifyWebhookSignature, activatePlan, isPlanActive, fetchPaymentLink } from '../services/billingService.js'
import { getBusinessById } from '../config/database.js'

export const billingRouter = Router()
const bid = req => req.headers['x-business-id']

// ── Get all plans + current plan status ───────────────
billingRouter.get('/plans', async (req, res) => {
  const businessId = bid(req)
  const business   = businessId ? await getBusinessById(businessId) : null

  res.json({
    plans: PLANS,
    current: business ? {
      plan:       business.plan || 'none',
      active:     business ? isPlanActive(business) : false,
      expiresAt:  business?.plan_expires_at || null,
    } : null,
  })
})

// ── Start checkout — payment link OR subscription ─────
billingRouter.post('/checkout', async (req, res) => {
  const businessId   = bid(req)
  const { plan, mode } = req.body // mode = 'one_time' | 'subscription'

  if (!businessId) return res.status(400).json({ error: 'x-business-id required' })
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' })

  try {
    const business = await getBusinessById(businessId)
    if (!business) return res.status(404).json({ error: 'Business not found' })

    let result
    if (mode === 'subscription') {
      result = await createSubscription(business, plan)
    } else {
      result = await createPaymentLink(business, plan)
    }

    res.json({ checkoutUrl: result.url, id: result.id })
  } catch (err) {
    console.error('Checkout error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Razorpay webhook — auto-activate on payment ───────
billingRouter.post('/webhook', async (req, res) => {
  res.sendStatus(200) // respond immediately

  const signature = req.headers['x-razorpay-signature']
  if (!verifyWebhookSignature(req.body, signature)) {
    console.warn('❌ Invalid Razorpay webhook signature')
    return
  }

  const event = req.body.event
  console.log('💳 Razorpay webhook:', event)

  try {
    // Payment link paid
    if (event === 'payment_link.paid') {
      const notes = req.body.payload?.payment_link?.entity?.notes
      if (notes?.business_id && notes?.plan) {
        await activatePlan(notes.business_id, notes.plan)
      }
    }
    // Subscription charged
    if (event === 'subscription.charged') {
      const notes = req.body.payload?.subscription?.entity?.notes
      if (notes?.business_id && notes?.plan) {
        await activatePlan(notes.business_id, notes.plan, req.body.payload.subscription.entity.id)
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message)
  }
})

// ── Callback after payment link redirect — activates plan as fallback ──
billingRouter.get('/callback', async (req, res) => {
  const frontend = process.env.FRONTEND_URL || 'http://localhost:3001'
  try {
    // Razorpay appends payment params. We also stored business_id + plan in notes,
    // but those don't come back on the redirect — so we read them from the payment link.
    const { razorpay_payment_link_id, razorpay_payment_id } = req.query

    if (razorpay_payment_link_id) {
      // Fetch the payment link to read its notes (business_id, plan)
      const link = await fetchPaymentLink(razorpay_payment_link_id)
      const notes = link?.notes
      if (notes?.business_id && notes?.plan && link?.status === 'paid') {
        await activatePlan(notes.business_id, notes.plan)
        return res.redirect(`${frontend}/dashboard/billing?status=success&plan=${notes.plan}`)
      }
    }
    // Could not auto-activate (e.g. subscription mode) — still send to billing,
    // the page will poll /status which the webhook will have updated.
    res.redirect(`${frontend}/dashboard/billing?status=success`)
  } catch (err) {
    console.error('Callback error:', err.message)
    res.redirect(`${frontend}/dashboard/billing?status=pending`)
  }
})

// ── Get current subscription status (frontend polls this) ──
billingRouter.get('/status', async (req, res) => {
  const businessId = bid(req)
  const business   = await getBusinessById(businessId)
  if (!business) return res.status(404).json({ error: 'Not found' })

  res.json({
    plan:      business.plan || 'none',
    active:    isPlanActive(business),
    expiresAt: business.plan_expires_at,
  })
})