// Baseline security headers. Applied globally so every response —
// including error paths and the WhatsApp webhook — carries them.
//
// This is a JSON API, so we can be aggressive: no inline scripts, no
// object embeds, no framing. The frontend (Next.js) sets its own CSP.
//
// Nothing here breaks WhatsApp/Razorpay webhook POSTs (they don't care
// about response headers). Nothing here breaks the browser dashboard
// making CORS calls — those headers are already set separately.

export function securityHeaders(_req, res, next) {
  // Force HTTPS for one year on any browser that ever lands here directly.
  // Only meaningful on https:// deployments; harmless otherwise.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')

  // No sniffing MIME types.
  res.setHeader('X-Content-Type-Options', 'nosniff')

  // Nobody frames this backend (it's an API — there's nothing to embed).
  res.setHeader('X-Frame-Options', 'DENY')

  // Don't leak our URL as a Referer to external destinations.
  res.setHeader('Referrer-Policy', 'no-referrer')

  // Restrict powerful browser APIs by default — API responses never need them.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')

  // CSP for the tiny bit of HTML this API returns (health, 404). Deny
  // everything; the frontend sets its own for the dashboard.
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  )

  next()
}
