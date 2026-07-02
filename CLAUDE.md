# CLAUDE.md — bizbot-backend

Context for future Claude Code sessions on this repo. Read this first.

## What this project is

BizBot — WhatsApp AI receptionist for Indian service businesses (salons,
clinics, etc.). One backend serves many tenants (`businesses`). Customers
message a business's WhatsApp number; Groq (Llama 3.3) generates replies;
appointments and payments are persisted in Supabase.

Stack: Node 20+ ESM · Express · Supabase (Postgres) · Groq API · Meta
WhatsApp Business API · Razorpay for billing · node-cron for scheduled
reminders.

## Directory map

```
src/
├── index.js                    Express bootstrap, CORS, graceful shutdown
├── ai/
│   ├── groqClient.js           Groq API wrapper (retry, rate-limit backoff)
│   ├── intentClassifier.js     LLM-based book/reschedule/query/other classifier
│   ├── conversationManager.js  Thin coordinator: LLM reply → decide action
│   ├── validator.js            Source of truth for booking rules (see below)
│   ├── messageTemplates.js     Reminder / rejection / re-engagement strings (EN + Hinglish)
│   └── prompt/                 Modular system prompt (rules + examples + business ctx)
├── services/
│   ├── aiService.js            Message orchestrator: save inbound → call Groq → save outbound
│   ├── bookingService.js       createBooking / rescheduleBooking / cancelUpcoming — all gated by validator
│   ├── paymentService.js       Creates pending payment records from services_list
│   ├── whatsappService.js      Meta WhatsApp send/read
│   ├── billingService.js       Razorpay checkout + webhook + plan activation
│   └── campaignService.js      Broadcasts
├── routes/                     REST + webhook endpoints
├── middleware/
│   ├── requireBusinessAuth.js  Supabase JWT + business ownership check
│   ├── requireActivePlan.js    Trial/plan expiry gate on write routes
│   ├── rateLimiter.js          Global per-IP limit (120 req/min)
│   └── logger.js               Request logger
├── config/
│   ├── database.js             All Supabase queries (helpers + paginated variants)
│   ├── schema.sql              Full fresh-install schema
│   └── migration-v7.sql        Idempotent migration for existing DBs
├── jobs/scheduler.js           Hourly appointment reminders + daily payment follow-ups
└── utils/
    ├── dateTime.js             IST-anchored date helpers
    ├── dateResolver.js         Deterministic date/time parser (Hindi + English)
    └── log.js                  Structured logger (pretty in dev, JSON in prod)
```

## Design decisions (do not undo without discussion)

**Backend owns date resolution.** Never trust the LLM for date math.
`src/utils/dateResolver.js` parses "kal shaam 4 baje" / "Friday" / "12
July" into ISO date + HH:MM. `aiService` injects the resolved values into
the system prompt as `BACKEND-RESOLVED FROM CUSTOMER MESSAGE:` so the
LLM works with real dates.

**Validator is the source of truth.** `src/ai/validator.js`
`validateBooking()` checks: service exists, business open, within hours,
before cutoff, not a holiday, not in the past, no duplicate, no
conflict, hour capacity not exceeded. Both the AI path AND the dashboard
manual-create route go through this — no other write path is allowed.

**Everything is IST.** DB stores UTC (`timestamptz`), but every business
rule anchors to Asia/Kolkata. Use `src/utils/dateTime.js` helpers, never
raw `new Date()` for business logic.

**Duplicate protection is four-layered.** Prompt (LLM told not to
re-book) → in-code same-customer check → in-code same-business check →
DB partial unique index `(customer_id, appointment_time) WHERE status =
'confirmed'`. The last one catches races.

**Cursor pagination, not offset.** All new list endpoints use keyset
pagination (`?cursor=<id>&limit=50`). Offset pagination isn't safe on
Supabase past ~1000 rows.

**Groq is the LLM.** `.env.example` mentions this; do NOT swap to
Anthropic without asking — user reverted that swap explicitly.

## Fixes applied in this refactor

Grouped by severity. See git log for the actual diffs.

### Correctness / architecture

- Backend now resolves dates instead of trusting the LLM.
- `validator.js` rewritten as source of truth for all booking rules
  (was a 17-line stub that only checked emoji markers).
- `conversationManager` split — `bookingService` and `paymentService`
  handle side-effects; conversationManager is a thin coordinator.
- `aiService.js` is a thin orchestrator (no booking logic).
- Message history windowed: last 6 turns verbatim + summary of older.
- Prompts tightened: one question at a time, shorter replies,
  never re-dump the service list.

### Bugs

- TZ bugs in `messageTemplates.js`, `paymentManager.js`,
  `getTodayAppointments`, `getDashboardStats`, and dashboard
  `remind-all` — all switched to IST-anchored boundaries.
- `.env.example` had stale `ANTHROPIC_API_KEY`; code uses Groq. Fixed.
- `dateResolver` sanity check used `getUTCDate()` on an IST-offset date
  and rejected every valid IST date. Fixed with UTC-anchored construction.
- N+1 in `getConversations` — was one query per customer for last-msg;
  now batched with `.in()`.
- Ratepayer webhook signature was verifying against a re-stringified
  body (broken); now uses `req.rawBody`.

### Security

- Added JWT auth middleware (`requireBusinessAuth`) — verifies
  Supabase token AND that the caller owns the `x-business-id`. Prevents
  cross-tenant reads/writes. Toggle: `AUTH_REQUIRED=true`.
- WhatsApp webhook now verifies `x-hub-signature-256` against
  `WHATSAPP_APP_SECRET`. Was previously accepting any POST.
- PostgREST injection risk in conversation search — sanitized `,()%_*"`.
- Business ownership check on `updateAppointmentStatus`.
- STOP word-boundary — was a substring match ("we should never stop
  trying" opted people out).
- CORS locked to `FRONTEND_URL` (was wildcard).
- Body-size cap `100kb`.

### Performance

- Cursor pagination on messages / appointments / conversations.
- Batched last-message lookup in `getConversations` (kills the N+1).
- Indexes added in `migration-v7.sql`:
  `messages(customer_id, created_at)`, `messages(business_id, created_at)`,
  `appointments(business_id, appointment_time)`,
  `appointments(customer_id, status, appointment_time)`,
  `payments(business_id, status, due_date)`,
  `payments(customer_id, status)`,
  `businesses(auth_user_id)`, `businesses(lower(email))`.

### Reliability

- `getOrCreateCustomer` race-safe via upsert + fallback SELECT.
- Webhook persists inbound BEFORE returning 200. Meta retries on crash.
- Reminder jobs mark-in-flight BEFORE send (missed reminder > duplicate).
- Graceful `SIGTERM` handler drains in-flight requests.
- Atomic visit-count via SQL RPC `increment_customer_visits`.
- Unbounded reads capped (default 500, max 2000).
- Structured logger available (`src/utils/log.js`).

### New features

- Hourly capacity limit — set `business.hourly_capacity` and validator
  rejects a booking that pushes past that count in the same IST hour.
- Booking rejection messages in English AND Hinglish, language detected
  from the customer's last message.
- Reminders and re-engagement messages also language-detected.

## Production checklist

Run these in order. Do not skip.

### 1. Apply the DB migration

Supabase SQL Editor → paste `src/config/migration-v7.sql` → run. Adds
indexes, the `hourly_capacity` column, the unique constraint that
prevents duplicate confirmed bookings, and the `increment_customer_visits`
SQL function.

### 2. Set environment variables

In your hosting provider (Railway, Vercel, etc.), set:

```
# LLM
GROQ_API_KEY=gsk_...           # https://console.groq.com/keys
GROQ_MODEL=llama-3.3-70b-versatile   # optional; re-check retirement schedule

# Supabase
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=<service-role-key>

# Meta WhatsApp
WHATSAPP_TOKEN=<system-user-token>
WHATSAPP_PHONE_ID=<phone-number-id>
WHATSAPP_VERIFY_TOKEN=<a-random-string-you-pick>
WHATSAPP_APP_SECRET=<app-secret-from-meta-app-settings>   # NEW — required in prod

# Razorpay
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=<key-secret>
RAZORPAY_WEBHOOK_SECRET=<webhook-secret-from-razorpay-dashboard>   # newly documented

# App URLs
APP_URL=https://api.yourdomain.com
FRONTEND_URL=https://app.yourdomain.com   # locks CORS. Comma-separate for multiple.

# Auth
AUTH_REQUIRED=true   # verifies JWT + business ownership on all authed routes

# Logging
LOG_LEVEL=info
LOG_FORMAT=json      # switches to JSON lines (better for aggregators)
```

All of these are global to the backend — one set covers every tenant.
Do not set them per client.

### 3. Update the frontend

Every call to `/api/dashboard/*`, `/api/payments/*`, `/api/broadcast/*`,
`/api/analytics/*` needs the caller's Supabase JWT:

```js
const { data: { session } } = await supabase.auth.getSession()
fetch('/api/dashboard/stats', {
  headers: {
    'x-business-id': currentBusinessId,
    'Authorization': `Bearer ${session.access_token}`,
  },
})
```

Also update to the new response shapes:

- `GET /conversations` returns `{ conversations: [...], nextCursor }`
  (was flat array). Fallback `?paginated=false` still returns flat.
- `GET /appointments` same shape. Fallback `?paginated=false`.
- `GET /conversations/:cid/messages` same shape. Fallback `?paginated=false`.

### 4. Meta webhook config

- Meta App → WhatsApp → Configuration → Webhook URL:
  `https://api.yourdomain.com/webhook`
- Verify Token: whatever you set for `WHATSAPP_VERIFY_TOKEN`.
- Subscribe to: `messages`, `message_status`.
- The signature verification uses `WHATSAPP_APP_SECRET` — get it from
  Meta App → App Settings → Basic → "App Secret" (click "Show").

### 5. Razorpay webhook config

- Razorpay Dashboard → Settings → Webhooks → Create.
- Webhook URL: `https://api.yourdomain.com/api/billing/webhook`.
- Set a Webhook Secret; use that as `RAZORPAY_WEBHOOK_SECRET`.
- Events: `payment_link.paid`, `subscription.charged`.

### 6. Migration flow (avoid breaking existing clients)

Suggested rollout order so nothing breaks mid-deploy:

1. Deploy backend with `AUTH_REQUIRED=false`. Everything works as today
   (all the other fixes are active but auth is bypassed).
2. Deploy frontend that sends `Authorization: Bearer <jwt>` on every call.
3. Verify a real user can still hit the dashboard end-to-end.
4. Set `AUTH_REQUIRED=true` in the backend env, redeploy.
5. Cross-tenant leaks are now blocked at the middleware layer.

### 7. Seed per-business config

For each `businesses` row, populate at minimum:

```sql
update businesses
   set business_hours   = '{"mon": {"open":"09:00","close":"20:00"}, "sun": {"closed":true}, ...}',
       services_list    = '[{"name":"Facial","price":4000,"category":"Face"}, ...]',
       last_booking_time = '19:00',       -- optional cutoff
       holidays          = '["2026-08-15","2026-10-02"]',   -- optional
       hourly_capacity   = 2               -- optional; null = unlimited
 where id = '...';
```

The validator gracefully skips checks whose column is null, so partial
config still works, but you'll get correct rejections only when the
relevant fields are set.

## Known caveats / not-yet-fixed

- **Frontend auth migration required.** With `AUTH_REQUIRED=true`, the
  dashboard MUST send the Supabase JWT. Everything else is ready.
- **Chat reload / high DB calls** — backend N+1 fixed; frontend polling
  cadence + Supabase realtime subscription are the real answer, not
  yet implemented.
- **No integration tests.** Unit tests exist only for the pure date
  utils (were run once during the refactor). No CI wiring.
- **Service-duration-aware capacity** — current capacity check buckets
  by IST hour of the *appointment start*. A 90-min service starting at
  3:30 doesn't reserve capacity in the 4:00 bucket. If services have
  variable durations, we need a different model.
- **Rolling-window capacity** — capacity check is per top-of-hour
  bucket, not a rolling 60-min window. Two bookings at 4:59 and 5:00
  count in different buckets.
- **`getUpcomingForReminder`** scans across all businesses at once. No
  business scope. Fine at current scale; watch it as data grows.
- **STOP handler is exact-match** (fixed a false-positive). If you want
  fuzzier matching ("plz stop", "please stop") we'd need a curated list.

## Conventions

- ESM only (`"type": "module"` in package.json). Use `import`, not `require`.
- Never call `new Date()` for business logic — use `nowIST()` /
  `istDateStr()` from `src/utils/dateTime.js`.
- All new list endpoints must return `{ items, nextCursor }`, never a flat
  array. Legacy escape via `?paginated=false` if a caller depends on the
  old shape during migration.
- Any write path that creates or mutates an appointment MUST go through
  `validateBooking()`. Do not insert directly into `appointments`.
- Prompts live only in `src/ai/prompt/`. Do not inline strings in
  services or routes.
- No emojis in code comments or user-facing text unless the user's
  product design already uses them (the WhatsApp bot does — that's
  fine). Do not add them to logs.

## Running locally

```
npm install
cp .env.example .env
# fill in credentials
npm run dev
# hit http://localhost:3000/health
```

Set `AUTH_REQUIRED=false` in local `.env` so you can hit the dashboard
routes without a JWT during development.
