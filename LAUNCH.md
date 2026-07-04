# BizBot — Launch Checklist (first customer)

Work top to bottom. This consolidates everything needed to go live and onboard
customer #1. See `DEPLOY.md` for deeper backend deploy notes.

---

## 0. Code is on `testing` — push it
```
git -C bizbot-backend  push origin testing
git -C bizbot-frontend push origin testing
```
- [ ] Decide your production branch. If prod deploys from **`main`**, merge `testing → main`
  once verified. If prod tracks **`testing`**, pushing is enough.

## 1. Run DB migrations (Supabase → SQL Editor, in this order)
Each is idempotent (safe to re-run). Paste + run:
- [ ] `src/config/migration-v7.sql`   — indexes, hourly_capacity, dup-booking constraint, RPC
- [ ] `src/config/admin-migration.sql`   — `suspended`, `admin_audit_log`, `support_notes`
- [ ] `src/config/template-migration.sql` — `templates.variable_examples`
- [ ] `src/config/cost-migration.sql`     — `campaign_recipients.billable/…`, `campaigns.actual_cost`

## 2. Backend env vars (Railway)
```
# LLM
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile
# Supabase
SUPABASE_URL=https://<ref>.supabase.co        # the API URL, NOT the dashboard URL
SUPABASE_SERVICE_KEY=<service-role key>
# WhatsApp (Meta)
WHATSAPP_TOKEN=<system-user token>
WHATSAPP_PHONE_ID=<default phone number id>
WHATSAPP_VERIFY_TOKEN=<random string you choose>
WHATSAPP_APP_SECRET=<Meta app secret>          # required in prod (webhook signature)
WHATSAPP_WABA_ID=<WhatsApp Business Account id> # required for template create/delete
# Razorpay
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=<secret>
RAZORPAY_WEBHOOK_SECRET=<webhook secret>
# URLs
APP_URL=https://<backend-url>
FRONTEND_URL=https://<vercel-url>              # locks CORS (comma-separate for multiple)
# Auth / admin
AUTH_REQUIRED=true
ADMIN_EMAILS=you@yourdomain.com                # or /admin denies everyone
# Optional
SENTRY_DSN=<sentry project dsn>                # error monitoring (recommended)
LOG_LEVEL=info
LOG_FORMAT=json
```
- [ ] All set. (One env set covers every tenant — never per-client.)

## 3. Frontend env vars (Vercel)
```
NEXT_PUBLIC_API_URL=https://<backend-url>
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```
- [ ] Set.

## 4. Deploy (rollout order matters for auth)
- [ ] Deploy **backend** first with `AUTH_REQUIRED=false` → everything works, auth bypassed.
- [ ] Deploy **frontend** (it sends the Supabase JWT on every call).
- [ ] Verify a real user reaches the dashboard end-to-end.
- [ ] Set `AUTH_REQUIRED=true` on the backend, redeploy. Cross-tenant leaks now blocked.

## 5. Webhooks
- [ ] **Meta** → App → WhatsApp → Configuration → Webhook URL `https://<backend>/webhook`;
  verify token = `WHATSAPP_VERIFY_TOKEN`; subscribe **messages** + **message_status**.
  App Secret (App Settings → Basic) → `WHATSAPP_APP_SECRET`.
- [ ] **Razorpay** → Settings → Webhooks → `https://<backend>/api/billing/webhook`;
  set a secret → `RAZORPAY_WEBHOOK_SECRET`; events `payment_link.paid`, `subscription.charged`.

## 6. Supabase auth config (dashboard, not code)
- [ ] Auth → URL Config: **Site URL** = Vercel URL; **Redirect URLs** include
  `https://<vercel>/**`, `https://<vercel>/auth/callback`, `http://localhost:3001/**`.
- [ ] Google provider enabled (Client ID + Secret) if using Google login.
- [ ] Email "Confirm email" on/off as you prefer.

## 7. Legal
- [ ] Fill the `[bracketed]` placeholders in `/privacy` and `/terms` (frontend) and
  get a lawyer's pass. Both are linked from signup.

---

## 8. Onboard customer #1
- [ ] **Meta / WABA setup for the client** (the biggest real-world step): Meta Business
  Verification; register their WhatsApp number; get their phone number id (+ WABA id).
- [ ] Store the client's `whatsapp_phone_id` (and `waba_id` if separate) on their
  `businesses` row — via the admin console (`/admin/clients/[id]`) or Settings.
- [ ] Seed config so the AI is accurate: the onboarding wizard sets services + default
  hours; then in **Settings** refine hours, `last_booking_time`, `holidays`,
  `hourly_capacity`, UPI.
- [ ] Create + get Meta approval for at least **1 utility reminder template** (needed for
  proactive reminders outside the 24h window) and any greeting/marketing templates.
- [ ] Turn them on. Watch **Conversations** + **Alerts** (booking failures) daily for the
  first week; tune prompts/config.

## 9. Smoke test (do this before handing to a real customer)
- [ ] Signup → onboarding (services + WhatsApp step) → lands on dashboard.
- [ ] Message the WhatsApp number → AI replies → completes a booking (read-back → "haan").
- [ ] Manual reminder from Appointments appears in that customer's chat.
- [ ] Conversation thread reads oldest→newest and scrolls to the latest message.
- [ ] `/admin` loads for your `ADMIN_EMAILS` account → extend trial / suspend / impersonate.
- [ ] Broadcast: create a campaign → cost preview shows the category price → send →
  status + actual cost update as webhooks arrive.
- [ ] Billing: trial → upgrade (Razorpay test card) → plan shows active.

## 10. Before the 30-day trial ends
- [ ] Razorpay **LIVE** keys verified end-to-end (trial → paid → plan activation).
- [ ] `SENTRY_DSN` set and errors are flowing (trigger a test error to confirm).

---

### Deferred (do NOT block customer #1)
Membership/renewal engine · template buttons · admin roles · richer segments ·
integration tests/CI. All valuable; none gate a single customer you watch closely.
