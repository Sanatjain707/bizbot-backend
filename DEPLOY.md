# DEPLOY.md — production deployment

End-to-end steps to ship BizBot to production. Covers backend (Railway),
frontend (Vercel), Supabase (Postgres + Auth), Meta WhatsApp Business, and
Razorpay. Follow top-to-bottom the first time; use the checklist at the
end for subsequent releases.

Estimated time for a clean run: **2-3 hours**, most of it waiting for
Meta / Razorpay verification.

---

## 0. Pre-flight

**Accounts you need**

- GitHub (both repos pushed)
- Supabase account
- Railway account
- Vercel account
- Meta Developer + WhatsApp Business API access (needs Facebook Business Manager)
- Razorpay merchant account (live mode enabled after KYC)
- Groq API key — `console.groq.com/keys`
- A domain name you control (e.g. `bizbot.yourdomain.com`)

**Local verification before shipping**

Run once against your dev/staging Supabase:

```
cd bizbot-backend
npm install
npm run dev      # /health returns 200, cron scheduler starts
cd ../bizbot-frontend
npm install
npm run build    # 18 pages compile clean
```

If either fails, stop — fix locally first. Don't diagnose in production.

**Migrations ready**

- Backend has `src/config/schema.sql` (fresh install) and
  `src/config/migration-v7.sql` (upgrade). Read both — you'll paste them
  into Supabase in step 2.

---

## 1. Supabase (production project)

Do NOT reuse your dev Supabase project. Create a fresh one for prod so
dev data can't leak.

1. **Create project** — `supabase.com` → New project → pick a region
   close to your users (Mumbai/`ap-south-1` for India), set the DB
   password (save it in a password manager).
2. **Wait ~5 min** for provisioning.
3. **Run the schema** — SQL Editor → paste `src/config/schema.sql` → Run.
4. **Run the migration** — SQL Editor → paste `src/config/migration-v7.sql` → Run.
   It's idempotent, safe to re-run later.
5. **Configure auth providers** — Authentication → Providers:
   - **Email** — enable, disable "Confirm email" for faster onboarding
     if you plan to gate features server-side (recommended: leave it on
     to prevent typo signups).
   - **Google** — enable, paste your OAuth client ID + secret from
     Google Cloud Console (Credentials → OAuth 2.0). Add
     `https://<supabase-project>.supabase.co/auth/v1/callback` as an
     authorised redirect URI.
6. **Redirect URLs** — Authentication → URL Configuration:
   - Site URL: `https://app.yourdomain.com` (your frontend URL from step 3).
   - Additional Redirect URLs: `https://app.yourdomain.com/auth/callback`.
7. **Session settings** — Authentication → Sessions:
   - JWT expiry: default 1h (fine).
   - Refresh token rotation: **enabled** (mitigates leaked-token risk).
   - Refresh token reuse interval: 10 seconds (default).
8. **Copy these values to a scratch note** — you'll paste them into
   Railway + Vercel in later steps:
   - Project URL (`https://<ref>.supabase.co`)
   - **anon key** (Settings → API) — public, safe to expose
   - **service_role key** (Settings → API) — **SECRET**, backend only, never in frontend

---

## 2. Backend on Railway

Backend is a stateful Node service (has cron jobs). Railway is a good fit;
Fly.io or Render work too — adapt the steps as needed.

1. **Push `bizbot-backend` to GitHub** if you haven't already.
2. **Railway → New Project → Deploy from GitHub repo** → pick the repo.
3. **Settings → Variables** — paste all of these:

   ```
   NODE_ENV=production
   PORT=3000

   # Groq
   GROQ_API_KEY=gsk_...
   GROQ_MODEL=llama-3.3-70b-versatile

   # Supabase (from step 1)
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_KEY=<service_role_key>

   # Meta WhatsApp (fill in step 4)
   WHATSAPP_TOKEN=<system-user-token>
   WHATSAPP_PHONE_ID=<phone-number-id>
   WHATSAPP_VERIFY_TOKEN=<pick-a-random-string>
   WHATSAPP_APP_SECRET=<meta-app-secret>

   # Razorpay (fill in step 5)
   RAZORPAY_KEY_ID=rzp_live_...
   RAZORPAY_KEY_SECRET=<live-secret>
   RAZORPAY_WEBHOOK_SECRET=<razorpay-webhook-secret>

   # URLs
   APP_URL=https://api.yourdomain.com     # this Railway service (custom domain)
   FRONTEND_URL=https://app.yourdomain.com # your Vercel URL

   # Auth — keep FALSE for the first deploy so nothing breaks the
   # frontend before you've updated it in step 7.
   AUTH_REQUIRED=false

   # Logging
   LOG_LEVEL=info
   LOG_FORMAT=json
   ```

4. **Settings → Networking → Public Networking** — enable, note the
   generated `<something>.up.railway.app` URL.
5. **Settings → Custom Domain** — add `api.yourdomain.com`, create the
   CNAME record it shows you at your DNS provider.
6. **Deploy** — Railway auto-deploys on push. Watch Deployments tab
   until it says "Success". Hit `https://api.yourdomain.com/health` —
   should return `{"status":"ok","service":"BizBot","time":"..."}`.
7. **Cron sanity** — logs should show `⏰ Cron jobs started` on boot.

**If deploy fails:**
- "Missing SUPABASE_URL" → an env var is missing / misspelled.
- Port bind errors → make sure `PORT` env var is set (Railway usually
  injects it, but the app reads `process.env.PORT`).
- Razorpay `key_id mandatory` at boot → the Razorpay constructor runs
  at import time; `RAZORPAY_KEY_ID` MUST be set even for a health check.

---

## 3. Frontend on Vercel

Frontend is a static/edge Next.js app — Vercel is basically native.

1. **Push `bizbot-frontend` to GitHub.**
2. **Vercel → Add New Project → Import** → pick the repo.
3. **Framework preset** — Next.js (auto-detected).
4. **Environment Variables** — Vercel prompts you before first deploy:

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key — NOT service_role>
   NEXT_PUBLIC_API_URL=https://api.yourdomain.com
   NEXT_PUBLIC_IDLE_TIMEOUT_MIN=60
   ```

   Do NOT set `NEXT_PUBLIC_BUSINESS_ID` — that was for a dev shortcut;
   in prod each user's businessId comes from the by-user lookup.

5. **Deploy.** Vercel builds and hosts. Note the `*.vercel.app` URL.
6. **Domains → Add** `app.yourdomain.com` — Vercel gives you a CNAME to
   add to your DNS provider. Verify.
7. **Update Supabase redirect URLs** (step 1.6 above) if you skipped
   them earlier — they need the real Vercel domain.

**Hit** `https://app.yourdomain.com` — should render the landing page.
Auth won't work end-to-end yet until the backend is fully configured
(step 6). Signup landing at `/onboarding` is expected before Meta/Razorpay
are wired.

---

## 4. Meta WhatsApp Business API

This is the longest step because Meta verification takes time. Start
early.

1. **Facebook Business Manager** — create or use an existing business.
2. **Meta Developer Portal** — `developers.facebook.com` → My Apps →
   Create App → "Business" → "WhatsApp".
3. **Add a phone number** — WhatsApp → API Setup → Add phone number
   (needs SMS verification to a real phone you control that ISN'T
   already on WhatsApp). Meta gives you a temporary test number for the
   first 5 numbers you send to; going live for arbitrary customers
   requires **business verification** (2-5 days).
4. **Note down**:
   - Phone Number ID → `WHATSAPP_PHONE_ID` in Railway
   - Temporary access token (24h) → replace with a **System User Token**
     for production (Business Settings → System Users → generate token
     with `whatsapp_business_messaging` + `whatsapp_business_management`
     scopes; that one lasts 60 days or forever depending on config).
   - Set that token as `WHATSAPP_TOKEN` in Railway.
5. **Webhook configuration** — Meta App → WhatsApp → Configuration:
   - Callback URL: `https://api.yourdomain.com/webhook`
   - Verify Token: match whatever you set as `WHATSAPP_VERIFY_TOKEN`.
   - Subscribe to fields: `messages`, `message_status`.
   - "Verify and Save" — Meta hits your `GET /webhook` with the verify
     token; the backend must be live for this to pass.
6. **App Secret** — Meta App → App Settings → Basic → "App Secret" →
   Show. Set as `WHATSAPP_APP_SECRET` in Railway. Redeploy.
7. **Templates** — WhatsApp → Message Templates → create the ones
   you'll broadcast. Wait ~30 min for Meta approval.

**Send a real test:**
```
curl -X POST https://graph.facebook.com/v19.0/<PHONE_ID>/messages \
  -H "Authorization: Bearer <WHATSAPP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","to":"91XXXXXXXXXX","type":"text","text":{"body":"hello from bizbot"}}'
```
The message should land on the target phone.

---

## 5. Razorpay

1. **Sign up** at `razorpay.com`, complete KYC (bank details, PAN, GST).
   Live mode unlocks after 24-72h.
2. **API Keys** — Settings → API Keys → Generate Live Key. Copy
   `key_id` (`rzp_live_...`) and `key_secret` into Railway.
3. **Webhook** — Settings → Webhooks → Create:
   - URL: `https://api.yourdomain.com/api/billing/webhook`
   - Active Events: `payment_link.paid`, `subscription.charged`
   - Alert Email: your ops email
   - **Secret**: click "Generate" — copy this into `RAZORPAY_WEBHOOK_SECRET`
     in Railway. Redeploy.
4. **Payment methods** — Settings → Configuration → enable UPI, cards,
   netbanking. UPI is the primary payment method in India for this
   customer base.
5. **Callback URL** — this is set per-payment-link inside our backend
   code (`APP_URL/api/billing/callback`). Nothing to configure in the
   Razorpay dashboard.

---

## 6. Post-deploy verification (with AUTH_REQUIRED=false)

Before turning auth on, verify the golden paths work.

- [ ] `curl https://api.yourdomain.com/health` → 200 with security
      headers (`Strict-Transport-Security`, `X-Content-Type-Options`, etc).
- [ ] Open `https://app.yourdomain.com/signup` → create a real account
      → complete onboarding → land on `/dashboard`.
- [ ] Send a WhatsApp message from a customer phone to your business
      number → bot replies. Watch Railway logs for
      `💬 [BusinessName] +91xxx: <message>`.
- [ ] Book: "kal shaam 4 baje facial" → bot sends read-back → reply
      "haan" → bot sends ✅. Check `appointments` table in Supabase.
- [ ] Try an invalid slot (closed day / past time / capacity full) →
      bot sends ✅ then a correction message → check
      `/dashboard/alerts` shows the failed attempt.
- [ ] From the dashboard, click "Remind all" for today → verify one
      customer gets a reminder.
- [ ] Go to `/dashboard/billing` → click a plan → complete a test
      Razorpay payment → verify `plan_expires_at` is set correctly
      (should be `now + plan.months` — 3 for Quarterly, 6 for
      Half-Yearly, 12 for Annual).

If ANY of these fail, do NOT proceed to step 7. Fix first.

---

## 7. Turn on JWT auth (AUTH_REQUIRED=true)

This is a one-way door — once flipped, unauthed requests to
`/api/dashboard/*` will 401. Your frontend already sends the JWT (per
the fixes in this session), so it should Just Work — but confirm first.

1. **Railway → Variables** → change `AUTH_REQUIRED` to `true`.
2. **Redeploy.**
3. **Verify** — log into `/dashboard` in a fresh browser session; every
   panel should load. Then log out and hit
   `https://api.yourdomain.com/api/dashboard/stats` directly with curl
   — should return `401 Missing Authorization: Bearer <token>`.

If your dashboard breaks after flipping:
- Open DevTools → Network → check that every `/api/dashboard/*`
  request has an `Authorization: Bearer eyJ...` header.
- If missing, your frontend build wasn't the one from the fixes session
  — redeploy the frontend before re-enabling auth.

Rollback: set `AUTH_REQUIRED=false` and redeploy backend. 30 seconds.

---

## 8. Monitoring + logs

**Railway (backend)**
- Deployments → click the running one → Logs tab. Stream is realtime.
- With `LOG_FORMAT=json`, every line is structured — use Railway
  filter or ship to Datadog/Better Stack.
- Alerts: Railway → Metrics → set CPU/memory alerts to Slack or email.

**Vercel (frontend)**
- Deployments → click → Runtime Logs (server-side) + Functions logs.
- Static pages are cached — bugs in client code only show up as user
  reports; add Sentry for error tracking (optional).

**Supabase**
- Database → Logs → Postgres logs (slow queries, errors).
- Auth → Users tab shows signups + failed login attempts.
- Reports → API usage.

**Set up before you get paged:**
- A Slack webhook that pings you when Railway deploys fail.
- Uptime monitoring on `https://api.yourdomain.com/health` — Better
  Stack, UptimeRobot, or Cronitor. 1-min interval.
- Email alerts on Meta App → Alerts (they page for phone-number issues,
  rate limits, template rejections).

---

## 9. Rollback plan

Everything critical is guarded by an env-var flag or a code redeploy,
so rollbacks are fast:

| Problem | Fix |
|---|---|
| Auth broke the dashboard | `AUTH_REQUIRED=false` on backend, redeploy (30s) |
| WhatsApp signature check blocking real messages | Unset `WHATSAPP_APP_SECRET`, redeploy (skips verify) |
| Razorpay webhook signature rejecting | Unset `RAZORPAY_WEBHOOK_SECRET`, redeploy |
| CORS blocked frontend | Unset `FRONTEND_URL`, falls back to wildcard |
| Bad backend deploy | Railway → Deployments → previous version → "Redeploy" |
| Bad frontend deploy | Vercel → Deployments → previous version → "Promote to Production" |
| DB migration broke something | `migration-v7.sql` is idempotent + additive; downgrade needs a hand-written script |
| Bad LLM model swap | Change `GROQ_MODEL` env var, redeploy |

**Don't roll back the DB** unless you have a backup restore. Supabase
takes daily backups on paid plans — verify yours before you need it.

---

## 10. Ongoing operations

**Adding a business owner**
- They sign up via `/signup` → Supabase Auth creates a user →
  `/onboarding` creates a `businesses` row keyed to their auth_user_id.
  Nothing manual on your side.

**Updating plan prices**
- Edit `PLANS` in `src/services/billingService.js` → deploy backend.
- Existing subscriptions on the old price keep charging the old
  amount until they end. New checkouts use the new amount.

**Rotating credentials**
- Meta app secret → change in Meta dashboard → update
  `WHATSAPP_APP_SECRET` → redeploy backend. Live webhook window has ~1
  minute of overlap where either secret works.
- Razorpay webhook secret → same pattern.
- Groq key → same.
- Supabase service_role → generate new in Supabase → update Railway →
  redeploy. **Old key stays valid until you explicitly revoke it in
  Supabase**, so this is zero-downtime.

**Model updates (Groq / Llama)**
- Groq rotates Llama versions on a retirement schedule. Watch
  `console.groq.com/docs/models`. When your `GROQ_MODEL` gets a
  deprecation warning, pick the successor and update the env var. Test
  in staging first — different versions have different vibes.

**Backups**
- Supabase Pro tier has PITR (point-in-time recovery). Enable it.
- Free tier: manual backups via Supabase dashboard weekly, or
  `pg_dump` on a schedule.

**Scaling**
- Backend: Railway auto-scales vertically. Cron and webhook are
  stateless (only cron scheduler needs single-instance semantics — do
  NOT scale to >1 replica or reminders will double-send).
- Frontend: Vercel edge network handles this by default.
- Supabase: check the metrics tab; upgrade tier when you hit connection
  limits or CPU walls.

---

## Deploy-day checklist (quick reference)

Copy-paste this into a Slack thread for launch day:

```
[ ] Local build clean (backend + frontend)
[ ] Supabase prod project created
[ ] schema.sql + migration-v7.sql applied
[ ] Supabase auth providers configured (email + Google)
[ ] Supabase redirect URLs point to prod frontend
[ ] Backend env vars set on Railway (AUTH_REQUIRED=false)
[ ] Backend deployed — /health returns 200 with security headers
[ ] Frontend env vars set on Vercel
[ ] Frontend deployed — landing page renders
[ ] DNS: api.yourdomain.com → Railway, app.yourdomain.com → Vercel
[ ] Meta app created, phone verified, webhook accepting
[ ] WHATSAPP_APP_SECRET set + backend redeployed
[ ] Razorpay webhook created with secret
[ ] RAZORPAY_WEBHOOK_SECRET set + backend redeployed
[ ] End-to-end signup + onboarding tested
[ ] End-to-end WhatsApp booking tested
[ ] End-to-end payment tested
[ ] Booking-failure alert tested (try a closed-day booking)
[ ] Flip AUTH_REQUIRED=true, redeploy backend
[ ] Dashboard still works for a real user
[ ] Uptime monitor pointed at /health
[ ] First real customer onboarded
```

You're live.
