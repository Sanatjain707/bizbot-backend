import { Router } from 'express'
import { getBusinessById, updateBusiness, createBusiness, supabase } from '../config/database.js'
import { requireUserAuth, requireBusinessAuth } from '../middleware/requireBusinessAuth.js'

export const businessRouter = Router()
const bid = req => req.headers['x-business-id']

// Tenant-scoped reads/writes MUST verify the caller owns the business.
// Was previously open to anyone with a valid business UUID.
businessRouter.get('/', requireBusinessAuth, async (req, res) => {
  const biz = await getBusinessById(bid(req))
  if (!biz) return res.status(404).json({ error: 'Business not found' })
  res.json(biz)
})

businessRouter.patch('/', requireBusinessAuth, async (req, res) => {
  const { id, razorpay_sub_id, plan_expires_at, ...safe } = req.body
  const { data, error } = await updateBusiness(bid(req), safe)
  if (error) return res.status(400).json({ error: error.message })
  res.json(data)
})

// Create — the user must be logged in, but they don't have a business yet,
// so we can't require business ownership. requireUserAuth verifies the JWT
// and also ensures the auth_user_id / email in the body matches the JWT
// (prevents an attacker from creating a business under someone else's identity).
businessRouter.post('/create', requireUserAuth, async (req, res) => {
  const { name, type, owner_name, services, pricing, working_hours, location, upi_id, whatsapp_phone_id, auth_user_id, email } = req.body
  if (!name) return res.status(400).json({ error: 'Business name required' })

  // Identity must match the JWT — an authenticated attacker can't create a
  // business under someone else's auth_user_id or email.
  if (auth_user_id && auth_user_id !== req.auth.userId) {
    return res.status(403).json({ error: 'auth_user_id does not match token' })
  }
  if (email && req.auth.email && String(email).trim().toLowerCase() !== req.auth.email.toLowerCase()) {
    return res.status(403).json({ error: 'email does not match token' })
  }

  // ── Guard against duplicates: if this user already has a business, return it ──
  // Match by auth_user_id first, then by email (catches same person via email↔Google).
  if (auth_user_id || email) {
    const cleanEmail = email ? String(email).trim().toLowerCase() : null
    let found = null
    if (auth_user_id) {
      const { data } = await supabase.from('businesses').select('*').eq('auth_user_id', auth_user_id).limit(1)
      found = data?.[0] || null
    }
    if (!found && cleanEmail) {
      const { data } = await supabase.from('businesses').select('*').ilike('email', cleanEmail.replace(/[%_*]/g, '')).limit(1)
      found = data?.[0] || null
      // Backfill auth_user_id if it was missing on the existing row
      if (found && auth_user_id && !found.auth_user_id) {
        await supabase.from('businesses').update({ auth_user_id }).eq('id', found.id)
      }
    }
    if (found) return res.status(200).json(found)  // already onboarded — no duplicate
  }

  const trialEnds = new Date()
  trialEnds.setDate(trialEnds.getDate() + 30)

  const { data, error } = await createBusiness({
    name, type, owner_name, services, pricing, working_hours, location, upi_id,
    whatsapp_phone_id: whatsapp_phone_id || null,
    auth_user_id: auth_user_id || null,
    email: email || null,
    plan: 'trial',
    plan_expires_at: trialEnds.toISOString(),
    waba_status: 'pending',
  })
  if (error) return res.status(400).json({ error: error.message })
  res.status(201).json(data)
})

// Find a business for a logged-in auth user (by auth_user_id or email).
// Used after login/Google to decide: go to dashboard (exists) or onboarding (new).
// JWT-gated + self-only — the caller can only look up THEIR OWN identity.
// Closes an email-enumeration attack where any unauthed request could probe
// which emails have BizBot accounts.
businessRouter.get('/by-user', requireUserAuth, async (req, res) => {
  const authId = req.query.auth_user_id
  const email  = req.query.email
  if (!authId && !email) return res.status(400).json({ error: 'auth_user_id or email required' })
  if (authId && authId !== req.auth.userId) {
    return res.status(403).json({ error: 'auth_user_id does not match token' })
  }
  if (email && req.auth.email && String(email).trim().toLowerCase() !== req.auth.email.toLowerCase()) {
    return res.status(403).json({ error: 'email does not match token' })
  }

  console.log(`🔎 by-user lookup → auth_user_id="${authId}" email="${email}"`)

  let business = null
  if (authId) {
    const { data, error } = await supabase.from('businesses').select('*').eq('auth_user_id', authId).limit(1)
    if (error) console.error('   auth_user_id query error:', error.message)
    business = data?.[0] || null
    console.log(`   by auth_user_id → ${business ? 'FOUND ' + business.id : 'not found'}`)
  }
  if (!business && email) {
    const { data, error } = await supabase.from('businesses').select('*').ilike('email', String(email).trim().toLowerCase().replace(/[%_*]/g, '')).limit(1)
    if (error) console.error('   email query error:', error.message)
    business = data?.[0] || null
    console.log(`   by email → ${business ? 'FOUND ' + business.id : 'not found'}`)
  }
  res.json({ business })
})

// Plan status — used by frontend for countdown + lock state. Gated so
// an attacker can't probe expiry dates of arbitrary businesses.
businessRouter.get('/plan-status', requireBusinessAuth, async (req, res) => {
  const biz = await getBusinessById(bid(req))
  if (!biz) return res.status(404).json({ error: 'Not found' })

  const now = new Date()
  const expires = biz.plan_expires_at ? new Date(biz.plan_expires_at) : null
  const active = expires ? expires > now : false
  const daysLeft = expires ? Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / 86400000)) : 0
  const isTrial = biz.plan === 'trial'

  res.json({
    plan: biz.plan || 'none',
    isTrial,
    active,
    daysLeft,
    expiresAt: biz.plan_expires_at,
    wabaStatus: biz.waba_status || 'pending',
    // what the frontend should do
    state: active ? (isTrial ? 'trial' : 'paid') : 'expired',
  })
})