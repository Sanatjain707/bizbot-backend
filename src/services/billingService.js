import 'dotenv/config'
import Razorpay from 'razorpay'
import crypto from 'crypto'
import { supabase } from '../config/database.js'

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
})

// ── Plan definitions ──────────────────────────────────
export const PLANS = {
  starter: { name: 'Starter', price: 999,  conversations: 200,   features: ['200 AI conversations/month', 'Appointment booking', 'Automated reminders', '1 WhatsApp number'] },
  growth:  { name: 'Growth',  price: 1999, conversations: 1000,  features: ['1,000 AI conversations/month', 'Everything in Starter', 'Payment follow-ups', 'Churn detection + re-engagement', 'Hindi/regional support'] },
  pro:     { name: 'Pro',     price: 3999, conversations: 99999, features: ['Unlimited conversations', 'Everything in Growth', 'Multi-location', 'Custom AI persona', 'Priority support'] },
}

// APP_URL      = this backend's public URL (http://localhost:3000 or Railway URL)
//                Razorpay redirects the customer here right after payment.
// FRONTEND_URL = your dashboard URL (http://localhost:3001 or Vercel URL)
//                The /callback route forwards the customer here to show success.

// ── Create a one-time payment link (manual renewal) ───
export async function createPaymentLink(business, planKey) {
  const plan = PLANS[planKey]
  if (!plan) throw new Error('Invalid plan')

  const link = await razorpay.paymentLink.create({
    amount:         plan.price * 100,
    currency:       'INR',
    accept_partial: false,
    description:    `BizBot ${plan.name} Plan — 1 month`,
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

// ── Create a recurring subscription (auto-renew) ──────
export async function createSubscription(business, planKey) {
  const plan = PLANS[planKey]
  if (!plan) throw new Error('Invalid plan')

  const rzpPlan = await razorpay.plans.create({
    period:   'monthly',
    interval: 1,
    item: {
      name:     `BizBot ${plan.name}`,
      amount:   plan.price * 100,
      currency: 'INR',
    },
    notes: { plan: planKey },
  })

  const subscription = await razorpay.subscriptions.create({
    plan_id:         rzpPlan.id,
    customer_notify: 1,
    total_count:     12,
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
export async function activatePlan(businessId, planKey, subscriptionId = null) {
  const expiresAt = new Date()
  expiresAt.setMonth(expiresAt.getMonth() + 1)

  await supabase.from('businesses').update({
    plan:            planKey,
    plan_expires_at: expiresAt.toISOString(),
    razorpay_sub_id: subscriptionId,
  }).eq('id', businessId)

  console.log(`✅ Plan activated: ${planKey} for business ${businessId}`)
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