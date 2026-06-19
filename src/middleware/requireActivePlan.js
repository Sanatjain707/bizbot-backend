import { getBusinessById } from '../config/database.js'
import { isPlanActive } from '../services/billingService.js'

// Blocks write/action requests when a business's plan/trial has expired.
// Reads remain allowed (GET). Billing routes are never blocked.
export async function requireActivePlan(req, res, next) {
  try {
    // Only gate write actions — reads (GET) always allowed so data stays viewable
    if (req.method === 'GET') return next()

    const businessId = req.headers['x-business-id']
    if (!businessId) return next()

    const business = await getBusinessById(businessId)
    if (!business) return next()

    if (isPlanActive(business)) return next()

    return res.status(402).json({
      error: 'plan_expired',
      message: 'Your trial or plan has expired. Upgrade to continue using this feature.',
    })
  } catch (err) {
    next() // fail open
  }
}