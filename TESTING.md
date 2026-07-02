# Testing Checklist — bizbot-backend

Every use case that changed or was added in this refactor. Go through
in order; each section builds on the previous one. Tick the boxes as
you verify each case in a real environment (staging Supabase +
WhatsApp sandbox + Razorpay test mode).

Use one test business, one WhatsApp phone number, one test customer
number. Reset the `appointments` and `messages` tables between sections
where noted.

---

## 0. Pre-flight

- [ ] `migration-v7.sql` applied to the target Supabase project.
- [ ] `.env` filled with real credentials (Groq, Supabase, WhatsApp, Razorpay).
- [ ] `AUTH_REQUIRED=false` for the first pass (flip to `true` at the auth section).
- [ ] `npm install` succeeds.
- [ ] `npm run dev` boots — logs show cron start + port.
- [ ] `curl /health` returns `{status: "ok"}`.

**Seed the test business** with realistic config so the validator has
something to check against:

```sql
update businesses set
  business_hours   = '{"mon":{"open":"09:00","close":"20:00"},"tue":{"open":"09:00","close":"20:00"},"wed":{"open":"09:00","close":"20:00"},"thu":{"open":"09:00","close":"20:00"},"fri":{"open":"09:00","close":"20:00"},"sat":{"open":"09:00","close":"20:00"},"sun":{"closed":true}}',
  services_list    = '[{"name":"Facial","price":4000,"category":"Face"},{"name":"Haircut","price":300,"category":"Hair"},{"name":"Hairwash","price":800,"category":"Hair"}]',
  last_booking_time = '19:00',
  hourly_capacity   = 2,
  holidays          = '["2026-08-15"]'
where id = '<your-test-business-id>';
```

---

## 1. Date resolver (backend-only, no LLM)

Unit-testable via a quick REPL — no WhatsApp needed.
Reference date: assume today is a Thursday, 2026-07-02.

- [ ] `resolveDateTime('kal aana hai')` → date=`2026-07-03`, time=null.
- [ ] `resolveDateTime('tomorrow at 4pm')` → date=`2026-07-03`, time=`16:00`.
- [ ] `resolveDateTime('parson 10am')` → date=`2026-07-04`, time=`10:00`.
- [ ] `resolveDateTime('friday')` → date=`2026-07-03` (next Fri).
- [ ] `resolveDateTime('shukravar')` → date=`2026-07-03`.
- [ ] `resolveDateTime('next friday')` → date=`2026-07-10` (a week out).
- [ ] `resolveDateTime('12 july')` → date=`2026-07-12`.
- [ ] `resolveDateTime('12-Jul-2026')` → date=`2026-07-12`.
- [ ] `resolveDateTime('12/7')` → date=`2026-07-12`.
- [ ] `resolveDateTime('shaam 4 baje')` → time=`16:00` (PM biased).
- [ ] `resolveDateTime('subah 9 baje')` → time=`09:00` (AM biased).
- [ ] `resolveDateTime('saade 4 baje')` → time=`16:30`.
- [ ] `resolveDateTime('sawa 3 baje')` → time=`15:15`.
- [ ] `resolveDateTime('paune 5 baje')` → time=`16:45`.
- [ ] `resolveDateTime('3:15 PM')` → time=`15:15`.
- [ ] `resolveDateTime('16:00')` → time=`16:00`.
- [ ] `resolveDateTime('30 feb')` → date=null (invalid).
- [ ] Past-in-year rolls: on 2026-07-02, `resolveDateTime('5 january')` → `2027-01-05`.

If any of these fail, don't proceed — the whole booking flow depends
on this being right.

---

## 2. Validator rules (in isolation)

Populate `businesses` as in section 0. Then hit `validateBooking` with
each case (call the function directly from a node REPL, or through a
booking that exercises it).

- [ ] Valid slot (Mon 15:00, Facial) → `{ valid: true, resolved: {...} }`.
- [ ] Unknown service → `code: 'unknown_service'`.
- [ ] Past date/time → `code: 'past_datetime'`.
- [ ] Sunday booking (closed) → `code: 'closed_day'`.
- [ ] 2026-08-15 booking (holiday) → `code: 'holiday'`.
- [ ] Booking at 08:00 (before hours) → `code: 'outside_hours'`.
- [ ] Booking at 21:00 (after close) → `code: 'outside_hours'`.
- [ ] Booking at 19:30 (after `last_booking_time` 19:00) → `code: 'after_cutoff'`.
- [ ] Same customer + same time (already booked) → `code: 'duplicate'`.
- [ ] With `hourly_capacity=2`, three bookings at 15:00, 15:00, 15:00 →
      first two succeed, third → `code: 'capacity_full'`.
- [ ] With `hourly_capacity=2` cleared to null → duplicate-at-same-minute
      guarded by `hasConflictingBooking` fires instead → `code: 'conflict'`.

---

## 3. WhatsApp webhook — inbound flow

Set `WHATSAPP_APP_SECRET` in `.env`. Use ngrok (or Railway URL) as the
webhook. Send from a test customer WhatsApp number.

### 3.1 Signature verification

- [ ] POST to `/webhook/` with NO `x-hub-signature-256` header → 401.
- [ ] POST with a wrong signature → 401.
- [ ] Real Meta-signed payload → 200, message processed.
- [ ] Unset `WHATSAPP_APP_SECRET` → verification skipped, 200
      (backward-compat behaviour).

### 3.2 Verify token (GET)

- [ ] GET `/webhook/?hub.mode=subscribe&hub.verify_token=<correct>&hub.challenge=abc`
      → 200 returning `abc`.
- [ ] Same with wrong token → 403.

### 3.3 Message parsing

- [ ] Send a plain text message → gets a greeting reply.
- [ ] Send an image (unsupported) → gets "Abhi sirf text messages…" reply.
- [ ] Send an interactive button reply → treated as text.
- [ ] Send a status update webhook (delivered/read) → 200, no reply.

### 3.4 Persist-before-200

- [ ] Send a message → verify the row is in `messages` table BEFORE the
      LLM reply arrives (there's a short window; you can hit it by
      killing Groq mid-request or by adding a temporary `throw` in
      `processMessage` before the `callGroq` call).
- [ ] Simulated crash between save and reply → Meta retries; NO duplicate
      inbound row is created next time (verify via message count).

---

## 4. Booking flow — happy path

Reset messages/appointments for the test customer between subsections.

### 4.1 Greeting

- [ ] Customer: `Hi` → Bot: warm greeting + full service list + "kaunsi service?"
- [ ] Follow-up: `facial kitne ka?` → Bot: "*₹4000*" + "kis din?" — must NOT re-dump the whole menu.

### 4.2 Book (all four details across turns)

- [ ] Customer: `facial book karna hai` → asks for date/time.
- [ ] Customer: `kal shaam 4 baje` → prompt now has resolved date.
      Bot asks for name (single question).
- [ ] Customer: `Priya` → Bot sends the read-back (no ✅) with all 4 details.
- [ ] Customer: `haan` → Bot sends the ✅ confirmation.
- [ ] DB check: one new row in `appointments` with `status=confirmed`,
      `appointment_time` = tomorrow 4pm IST in UTC.
- [ ] DB check: one new row in `payments` with `amount=4000`, `status=pending`,
      `due_date` = end of next IST day.

### 4.3 Book (all four in one message)

- [ ] From a fresh customer, send: `Priya. Facial kal shaam 4 baje.`
- [ ] Bot sends read-back (no ✅). Customer: `haan`. Bot sends ✅.
- [ ] DB: exactly one appointment row + one payment row.

### 4.4 Reschedule

- [ ] Existing confirmed appointment; customer: `kal ki appointment 5pm kar do`
- [ ] Bot confirms with ✅. Same `appointments.id` is UPDATED — no new
      row. `reminder_sent` is reset to false.

### 4.5 Cancel

- [ ] Customer: `appointment cancel kar do` → Bot: exact string
      `❌ Appointment cancelled for [Name]. Aap dobara kabhi bhi book kar sakte hain! 🙏`
- [ ] DB: `status='cancelled'` on the row.

### 4.6 Existing-appointment query (must NOT re-book)

- [ ] Existing confirmed appointment; customer: `meri appointment kab hai?`
- [ ] Bot answers with plain text: `Aapki appointment [date] ko [time]…`
- [ ] NO ✅ in the reply.
- [ ] NO new row in `appointments`.

### 4.7 Multi-service

- [ ] Customer: `facial + hairwash kal 4pm`
- [ ] Read-back has TWO 💆 lines and a 💰 Total: *₹4800*.
- [ ] After `haan` → single appointment created (back-to-back).

---

## 5. Booking rejection paths (correction message)

For each, the LLM sends a ✅ but the validator rejects. You should see
TWO messages arrive on WhatsApp: the ✅ from the LLM, then the
Hinglish/English correction.

- [ ] **Closed day** — book Sunday → "us din hum band rehte hain…"
- [ ] **Holiday** — book 2026-08-15 → "us din holiday hai…"
- [ ] **Outside hours** — book 08:00 → "hamare working hours ke bahar hai…"
- [ ] **After cutoff** — book 19:30 → "last booking cutoff…"
- [ ] **Past date/time** — say "aaj 8am" after 8am → "wo time nikal chuka hai…"
- [ ] **Unknown service** — book "manicure" (not in services_list) →
      "ye service hamari list mein nahi hai…"
- [ ] **Duplicate** — same customer, same time, twice → second attempt
      gets "aap ye slot pehle se book kar chuke hain…"
- [ ] **Capacity full** — with `hourly_capacity=2`, three different
      customers try to book 15:00 same day → third gets
      "us hour mein saari slots book ho chuki hain (max 2 per hour)…"
- [ ] **Conflict** — with `hourly_capacity=null`, two different
      customers try to book exactly 15:00 → second gets "wo slot abhi
      kisi aur ne le liya…"

---

## 6. Language detection

Same rejection case (say "closed day"), verify tone matches the
customer's language.

- [ ] Customer types `Book me on Sunday please` → correction is in
      **English** ("Sorry 🙏 we're closed that day…").
- [ ] Customer types `Ravivar ko book kar do` → correction is in
      **Hinglish** ("us din hum band rehte hain…").
- [ ] Customer types (devanagari) `रविवार को book करना है` → correction is
      **Hinglish**.
- [ ] Reminder cron: seed one English customer + one Hinglish customer
      with appointments in the next 24h; run the reminder cron
      (temporarily change the cron schedule to `* * * * *` for one
      minute). Verify each customer gets a reminder in their language.

---

## 7. Duplicate protection at DB level

- [ ] Ensure the partial unique index exists:
      `select indexname from pg_indexes where indexname='uniq_appointments_customer_time_confirmed';`
- [ ] Race test: fire two `createAppointment` calls at the exact same
      customer_id + appointment_time from two shells. Second should
      throw a `duplicate key value violates unique constraint`.
- [ ] Cancel one and re-book same time → should succeed (partial
      index only covers `status='confirmed'`).

---

## 8. Payment creation

- [ ] Book a service that IS in `services_list` → payment row created
      with the price from `services_list`.
- [ ] Book a service that is NOT in `services_list` → NO LLM fallback
      (short-circuit added); payment row not created.
- [ ] Business with only free-text `pricing` and no `services_list`
      → payment row created with LLM-extracted price.
- [ ] `due_date` = end-of-next-IST-day. Verify UTC time is `18:29:59.999Z`
      of the next-IST-day (i.e. midnight IST of the day after).

---

## 9. Dashboard endpoints — auth

Toggle `AUTH_REQUIRED=true`.

- [ ] `GET /api/dashboard/stats` with no `Authorization` header → 401.
- [ ] Same with `Authorization: Bearer <bogus>` → 401.
- [ ] Same with a real Supabase JWT of user A + `x-business-id` of
      business B (owned by user B) → 403.
- [ ] Real Supabase JWT of user A + `x-business-id` of user A's own
      business → 200, real stats returned.
- [ ] `AUTH_REQUIRED=false` → same request with no token → 200
      (auth bypassed).

---

## 10. Dashboard endpoints — pagination

- [ ] Seed >100 messages for one customer.
- [ ] `GET /api/dashboard/conversations/:cid/messages?limit=50` →
      returns `{ messages: [50 rows], nextCursor: '<uuid>' }`.
- [ ] `GET /api/dashboard/conversations/:cid/messages?limit=50&cursor=<from-above>`
      → returns the NEXT 50, no overlap.
- [ ] `?paginated=false` → returns a flat array (legacy shape).
- [ ] Same three checks on `/appointments` and `/conversations`.
- [ ] Search on conversations: `?search=priya` → returns matches, no injection possible.
- [ ] Try `?search=x),plan.eq.paid` → treated as literal text, no
      injection. No extra data returned.

---

## 11. Dashboard endpoints — cross-tenant safety

- [ ] User A (JWT) tries `PATCH /api/dashboard/appointments/<id-of-business-B>`
      → 404 "Appointment not found".
- [ ] User A tries `POST /api/dashboard/appointments/create` with
      x-business-id of B → 403 from middleware.
- [ ] User A tries `POST /api/dashboard/customers/import` for B → 403.

---

## 12. Capacity limit

With `hourly_capacity=2`:

- [ ] Book 3 different customers at slot times 14:15, 14:30, 14:45 →
      third gets `capacity_full` correction (all three are in the 14:00
      IST bucket).
- [ ] Book two more at 15:00, 15:30 → both succeed (different bucket).
- [ ] Bump capacity to 100 → verify 3 concurrent same-hour bookings
      all succeed.
- [ ] Cross-hour boundary: bookings at 14:59 and 15:00 → both counted
      in DIFFERENT buckets (documented caveat).

---

## 13. STOP / opt-out

- [ ] Customer sends exactly `stop` → opts out. `customers.opted_out=true`.
- [ ] Customer sends `STOP` (uppercase) → opts out.
- [ ] Customer sends `Stop.` → opts out.
- [ ] Customer sends `we should never stop trying` → does NOT opt out.
- [ ] Customer sends `band karo` → opts out.
- [ ] Customer sends `band karo yaar meri energy` → does NOT opt out
      (not an exact-match phrase).

---

## 14. Reminders cron (temporarily fast-forward)

Change appointment reminder cron to `* * * * *` in `scheduler.js` for
this test only. Revert after.

- [ ] Create a confirmed appointment 23h in the future, `reminder_sent=false`.
- [ ] Wait a minute → reminder is sent, `reminder_sent=true`.
- [ ] Same appointment second minute → no double-send.
- [ ] Kill the process AFTER `markReminderSent` but BEFORE `sendMessage`
      (add a temporary `throw` between them) → verify reminder is marked
      sent but NOT delivered. This is the acceptable failure mode
      (missed > duplicate).
- [ ] Payment reminder cron: pending payment with `due_date` 5 days
      overdue AND business's `payment_reminder_days=3` → reminder sent
      once, then `reminder_sent=true`.

---

## 15. CORS

- [ ] With `FRONTEND_URL=https://app.yourdomain.com`, a browser at
      `https://malicious.com` fetching `/api/dashboard/stats` → CORS
      error in browser console.
- [ ] Legit frontend at the allowed origin → CORS pre-flight passes.
- [ ] `FRONTEND_URL` unset → wildcard, all origins allowed.
- [ ] `FRONTEND_URL=https://a.com,https://b.com` → both allowed.

---

## 16. Rate limit + body size

- [ ] Send 121 requests in a minute from one IP → 429 on the 121st.
- [ ] POST a body >100kb → 413 Payload Too Large.
- [ ] Bulk import 5000 customers → succeeds (assuming under 100kb —
      test with a realistic 5000-row JSON).

---

## 17. Razorpay webhook

- [ ] POST `/api/billing/webhook` with NO `x-razorpay-signature` → silently
      ignored (returns 200 immediately but skips processing).
- [ ] POST with wrong signature → same.
- [ ] POST with correct signature + `event=payment_link.paid` +
      valid `notes` → business plan activated in DB
      (`plan`, `plan_expires_at`, `razorpay_sub_id` updated).
- [ ] POST correct signature + `event=subscription.charged` → same activation.

---

## 18. Boot + shutdown

- [ ] `npm run dev` → logs cron start, port, no errors.
- [ ] `/health` returns 200 with `time` in UTC ISO.
- [ ] Send SIGTERM (Ctrl+C in dev) → "SIGTERM received — draining requests…"
      logged, process exits within 10s.
- [ ] Send SIGTERM while a request is in flight → log shows "server closed."
      only after the request finishes.

---

## 19. Analytics + billing routes

- [ ] `GET /api/analytics/kpis?from=...&to=...` returns numbers with
      real appointment/payment data.
- [ ] `GET /api/billing/plans` returns all 3 plan definitions.
- [ ] `POST /api/billing/checkout` with `{plan:'starter', mode:'one_time'}`
      returns a real Razorpay payment link URL.
- [ ] Complete a test-mode Razorpay payment → callback route redirects
      to `FRONTEND_URL/dashboard/billing?status=success&plan=starter`.
- [ ] After callback OR webhook fires → `/api/billing/status` returns
      `{active: true, plan: 'starter', ...}`.

---

## 20. Migration idempotency

- [ ] Run `migration-v7.sql` on a fresh DB → all statements succeed.
- [ ] Run it AGAIN on the same DB → all statements succeed (no
      "column already exists" or "index already exists" errors).

---

## Pass criteria before flipping to production

At minimum:
- All of section 1 (date resolver) passes.
- 4.2 (happy-path booking) passes end-to-end.
- 5 (rejection paths) fires the correction message for at least
  `capacity_full` + `closed_day` + `outside_hours`.
- 9 (auth) passes with `AUTH_REQUIRED=true`.
- 10 (pagination) — at least one paginated endpoint verified with real data.
- 15 (CORS) — legitimate origin passes, wildcard confirmed off.
- 17 (Razorpay signature) — one real webhook activation succeeds.

Anything below section 15 is important but not launch-blocking if
you're doing a soft rollout.
