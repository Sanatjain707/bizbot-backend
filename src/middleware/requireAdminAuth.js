// Platform-admin gate for the operator console (/api/admin/*). Verifies the
// Supabase JWT AND that the caller's email is in the ADMIN_EMAILS allowlist.
// These routes are cross-tenant (they read/write across every business), so
// they are gated harder than the per-tenant requireBusinessAuth.
//
// Upgrade path: swap the allowlist check for a platform_admins table + roles
// without touching any caller.

import { supabase } from '../config/database.js'

const AUTH_REQUIRED = process.env.AUTH_REQUIRED !== 'false'
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

export function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.includes(String(email).trim().toLowerCase())
}

export async function requireAdminAuth(req, res, next) {
  // Dev bypass mirrors requireBusinessAuth: with AUTH_REQUIRED=false (localhost
  // only) we skip JWT verification. NEVER run the admin console with auth off
  // anywhere but local dev.
  if (!AUTH_REQUIRED) {
    req.admin = { email: ADMIN_EMAILS[0] || 'dev@local' }
    return next()
  }
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' })
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' })
    if (!isAdminEmail(user.email)) return res.status(403).json({ error: 'Not a platform admin' })
    req.admin = { userId: user.id, email: user.email }
    next()
  } catch (err) {
    console.error('requireAdminAuth error:', err.message)
    res.status(500).json({ error: 'Admin auth check failed' })
  }
}
