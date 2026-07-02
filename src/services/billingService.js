import 'dotenv/config'
import Razorpay from 'razorpay'
import crypto from 'crypto'
import { supabase } from '../config/database.js'

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
})

// ── Plan definitions ──────────────────────────────────
// Same product, three commitment lengths. Longer commitment = lower effective
// monthly cost — standard SaaS pattern. `months` drives the expiry math in
// activatePlan and the Razorpay subscription total_count.
//
// Base rate: ₹999/month. Savings are relative to the quarterly rate.
const BASE_FEATURES = [
  'Unlimited AI WhatsApp conversations',
  'Appointment booking + reminders',
  'Automated payment follow-ups',
  'Customer re-engagement + broadcasts',
  'Full dashboard + analytics',
  'Hindi & English support',
]

export const PLANS = {
  quarterly: {
    name: 'Quarterly',
    months: 3,
    price: 2997,            // ₹999/mo × 3
    effectiveMonthly: 999,
    savingsPct: 0,
    tagline: 'Try it for a quarter',
    features: BASE_FEATURES,
  },
  half_yearly: {
    name: 'Half-Yearly',
    months: 6,
    price: 5394,            // ₹899/mo × 6 (10% off)
    effectiveMonthly: 899,
    savingsPct: 10,
    tagline: 'Most popular',
    popular: true,
    features: [...BASE_FEATURES, 'Save 10% vs quarterly'],
  },
  annual: {
    name: 'Annual',
    months: 12,
    price: 9588,            // ₹799/mo × 12 (20% off)
    effectiveMonthly: 799,
    savingsPct: 20,
    tagline: 'Best value',
    features: [...BASE_FEATURES, 'Save 20% vs quarterly', 'Priority support'],
  },
}

// APP_URL      = this backend's public URL (http://localhost:3000 or Railway URL)
//                Razorpay redirects the customer here right after payment.
// FRONTEND_URL = your dashboard URL (http://localhost:3001 or Vercel URL)
//                The /callback route forwards the customer here to show success.

// ── Create a one-time payment link (full period upfront) ──
export async function createPaymentLink(business, planKey) {
  const plan = PLANS[planKey]
  if (!plan) throw new Error('Invalid plan')

  const link = await razorpay.paymentLink.create({
    amount:         plan.price * 100,
    currency:       'INR',
    accept_partial: false,
    description:    `BizBot ${plan.name} Plan — ${plan.months} months`,
    customer: {
      name:    business.owner_name || business.name,
      contact: business.owner_phone || '',
    },
    notify:          { sms: true, email: false },
    reminder_enable: true,
    notes: {
      business_id: business.id,
      plan:        planKey,
      type:        'one_time',
    },
    callback_url:    `${process.env.APP_URL}/api/billing/callback`,
    callback_method: 'get',
  })

  return { url: link.short_url, id: link.id }
}

// ── Create a recurring subscription (auto-renew per period) ──
// Razorpay charges the full period amount every plan.months months, up to
// total_count cycles. Two-year commitment on quarterly, one-year on the
// others — matches the reality that annual plan doesn't need to renew often.
export async function createSubscription(business, planKey) {
  const plan = PLANS[planKey]
  if (!plan) throw new Error('Invalid plan')

  const rzpPlan = await razorpay.plans.create({
    period:   'monthly',
    interval: plan.months,        // charge once per plan-period
    item: {
      name:     `BizBot ${plan.name}`,
      amount:   plan.price * 100,
      currency: 'INR',
    },
    notes: { plan: planKey, months: String(plan.months) },
  })

  // Cap subscriptions at ~2 years total so the customer keeps agency over
  // very long commitments (they can always re-subscribe).
  const totalCount = Math.max(1, Math.floor(24 / plan.months))

  const subscription = await razorpay.subscriptions.create({
    plan_id:         rzpPlan.id,
    customer_notify: 1,
    total_count:     totalCount,
    notes: {
      business_id: business.id,
      plan:        planKey,
      type:        'subscription',
    },
  })

  return { url: subscription.short_url, id: subscription.id }
}

// ── Verify webhook signature ──────────────────────────
// Razorpay signs the RAW JSON body. Re-JSON.stringify'ing a parsed body
// loses whitespace/key-order and breaks the HMAC — so we require the raw
// buffer captured by express.json({ verify: ... }).
export function verifyWebhookSignature(rawBody, signature) {
  if (!rawBody || !signature) return false
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody))
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)))
  } catch (_) { return false }
}

// ── Handle successful payment — activate plan ─────────
// Expiry = now + plan.months. Was previously hardcoded to +1 month which
// silently under-credited annual buyers by 11 months.
export async function activatePlan(businessId, planKey, subscriptionId = null) {
  const plan = PLANS[planKey]
  if (!plan) {
    console.error(`⚠️ activatePlan: unknown plan "${planKey}"`)
    return
  }
  const expiresAt = new Date()
  expiresAt.setMonth(expiresAt.getMonth() + plan.months)

  await supabase.from('businesses').update({
    plan:            planKey,
    plan_expires_at: expiresAt.toISOString(),
    razorpay_sub_id: subscriptionId,
  }).eq('id', businessId)

  console.log(`✅ Plan activated: ${planKey} (${plan.months} months) for business ${businessId}`)
}

// ── Fetch a payment link's current status + notes ─────
export async function fetchPaymentLink(linkId) {
  try {
    return await razorpay.paymentLink.fetch(linkId)
  } catch (err) {
    console.error('fetchPaymentLink error:', err.message)
    return null
  }
}

// ── Check if plan is active ───────────────────────────
export function isPlanActive(business) {
  if (!business.plan_expires_at) return false
  return new Date(business.plan_expires_at) > new Date()
}