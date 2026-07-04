import rateLimit from 'express-rate-limit'

// Global per-IP limit — coarse defence against a single hostile IP hitting
// arbitrary endpoints. Kept at 120/min so the dashboard's parallel loads
// don't trip it.
export const rateLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
})

// Per-tenant limit — protects against a compromised business account (or
// buggy dashboard client) that spams a specific tenant's routes. Keys off
// x-business-id when present, falls back to IP so unauthed calls still
// count against the caller. 60/min is generous for a real dashboard user.
export const tenantRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const tid = req.auth?.businessId || req.headers['x-business-id']
    if (tid) return `biz:${tid}`
    return `ip:${req.ip}`
  },
  message: { error: 'Too many requests for this business' },
})
