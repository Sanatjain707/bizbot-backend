// Two auth middlewares:
//
//   requireUserAuth      — verify Supabase JWT only. Populates req.auth =
//                          { userId, email }. Use for routes that need the
//                          caller to be logged in but don't scope by business
//                          (e.g. /api/business/by-user, POST /api/business/create).
//
//   requireBusinessAuth  — everything above + checks the caller owns the
//                          business named in x-business-id. Use for every
//                          tenant-scoped endpoint (dashboard, analytics, etc).
//
// Toggle: AUTH_REQUIRED=false disables both — dev/migration only. Never in prod.

import { supabase } from '../config/database.js'

const AUTH_REQUIRED = process.env.AUTH_REQUIRED !== 'false'

async function verifyJwt(req, res) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) { res.status(401).json({ error: 'Missing Authorization: Bearer <token>' }); return null }
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) { res.status(401).json({ error: 'Invalid or expired token' }); return null }
  return user
}

export async function requireUserAuth(req, res, next) {
  // Even in dev mode (AUTH_REQUIRED=false) we set req.auth = {} so downstream
  // route handlers can safely read req.auth.userId without a TypeError.
  // Was crashing the whole Node process on Railway (unhandled rejection).
  req.auth = req.auth || {}
  if (!AUTH_REQUIRED) return next()
  try {
    const user = await verifyJwt(req, res)
    if (!user) return
    req.auth = { userId: user.id, email: user.email }
    next()
  } catch (err) {
    console.error('requireUserAuth error:', err.message)
    res.status(500).json({ error: 'Auth check failed' })
  }
}

export async function requireBusinessAuth(req, res, next) {
  const businessId = req.headers['x-business-id']
  // Same defensive default as requireUserAuth so downstream handlers can
  // safely read req.auth.businessId regardless of auth mode.
  req.auth = req.auth || {}
  if (businessId) req.auth.businessId = businessId
  if (!AUTH_REQUIRED) {
    if (!businessId) return res.status(400).json({ error: 'x-business-id required' })
    return next()
  }
  if (!businessId) return res.status(400).json({ error: 'x-business-id required' })

  try {
    const user = await verifyJwt(req, res)
    if (!user) return

    // The business must belong to this user. Match by auth_user_id (primary)
    // or by email (legacy rows written before the column existed).
    let owns = false
    const { data: byId } = await supabase.from('businesses')
      .select('id').eq('id', businessId).eq('auth_user_id', user.id).limit(1)
    if (byId?.length) owns = true
    if (!owns && user.email) {
      const { data: byEmail } = await supabase.from('businesses')
        .select('id').eq('id', businessId).ilike('email', user.email.toLowerCase()).limit(1)
      if (byEmail?.length) owns = true
    }
    if (!owns) return res.status(403).json({ error: 'Business not owned by this user' })

    req.auth = { userId: user.id, email: user.email, businessId }
    next()
  } catch (err) {
    console.error('requireBusinessAuth error:', err.message)
    res.status(500).json({ error: 'Auth check failed' })
  }
}
