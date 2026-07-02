// Verifies that the caller is authenticated with Supabase AND owns the
// business referenced by the x-business-id header. Prevents anyone with a
// guessed/leaked business UUID from reading or mutating another tenant's
// data — the root safety fix that everything downstream depends on.
//
// Enabled by default. Set AUTH_REQUIRED=false to disable during migration
// (dev-only escape hatch — DO NOT set this in production).

import { supabase } from '../config/database.js'

const AUTH_REQUIRED = process.env.AUTH_REQUIRED !== 'false'

export async function requireBusinessAuth(req, res, next) {
  if (!AUTH_REQUIRED) {
    // Fallback: at least require a business id header. Reads still work
    // in dev without a JWT, but there's no cross-tenant check.
    if (!req.headers['x-business-id']) return res.status(400).json({ error: 'x-business-id required' })
    return next()
  }

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' })

  const businessId = req.headers['x-business-id']
  if (!businessId) return res.status(400).json({ error: 'x-business-id required' })

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' })

    // The business must belong to this user. We match by auth_user_id
    // (populated at signup) OR email (for legacy rows written before that
    // column existed).
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
    console.error('auth middleware error:', err.message)
    res.status(500).json({ error: 'Auth check failed' })
  }
}
