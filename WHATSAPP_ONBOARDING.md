# WhatsApp Onboarding SOP — per customer (Model A)

Model A = every client's number lives under **your** WABA and sends on **your**
platform token. Follow the per-customer checklist below for each new client.

## ⚠️ Two things to sort before you scale past the first few customers
- [ ] **Meta Business Verification** — needs a registered business (registration doc +
  address proof). Unverified you're capped low (a couple of numbers, limited daily
  reach) — fine for the first customer, a blocker for growth.
- [ ] **Payment method on your WhatsApp account** — service replies inside the 24h window
  are free, but proactive **reminders / templates / broadcasts cost money and fail
  without a payment method**. You pay Meta and bill the client.

---

## One-time setup (do once, yours)
- [ ] Meta **Business Manager** created.
- [ ] Meta **App** with the **WhatsApp** product added; note the **App ID** (→ `WHATSAPP_APP_ID`).
- [ ] A **WABA** (WhatsApp Business Account) under your Business (→ `WHATSAPP_WABA_ID`).
- [ ] A **System User** with a **permanent token** (→ `WHATSAPP_TOKEN`).
- [ ] App **webhook** set once → `https://<backend>/webhook`, verify token =
  `WHATSAPP_VERIFY_TOKEN`, subscribed to **messages** + **message_status**.
  This one webhook covers **every** number you later add under the WABA.

---

## Per-customer checklist (the click-path)

1. [ ] **Dedicated number.** Confirm the client's number is **NOT signed in to the regular
   WhatsApp / WhatsApp Business app** — the Business API can't share a number with the app.
   Either use a brand-new number, or have them delete WhatsApp on their existing one first.
   It must be able to receive an **SMS/voice OTP**.
2. [ ] **Add the number.** Meta **Business Manager → WhatsApp Manager → your WABA →
   Phone numbers → Add phone number** → enter the number.
3. [ ] **OTP verify.** Choose SMS or voice → enter the code Meta sends to that number.
4. [ ] **Display name → approval.** Set the **Display Name** to the client's business name
   and **submit for review**. It must match the real business and follow Meta's
   display-name rules. Wait for **Approved** (usually quick). *(Status also shows in
   BizBot → Settings → WhatsApp Profile.)*
5. [ ] **Copy the Phone number ID** from the number's row in WhatsApp Manager.
6. [ ] **Paste it into BizBot** → **Admin → Clients → [this client] → WhatsApp Phone
   Number ID** (or the client's own **Settings**). Save.
7. [ ] **Confirm the webhook** is receiving — it's the app-level webhook from one-time
   setup, so no per-number wiring; just verify a test message arrives.
8. [ ] **Mark live + test.** In the admin console set the client's **WABA status → live**,
   then message the number and confirm BizBot's AI replies and can complete a booking.
9. [ ] **Profile & logo.** In BizBot → **Settings → WhatsApp Profile**, upload the client's
   **logo** and fill about / category / address so their chats look branded.

Done — the client's **name + logo** now show on every customer chat, and BizBot handles
replies. Watch **Conversations** + **Alerts** closely for the first week.

---

## Notes
- The client can **no longer use the normal WhatsApp app** on that number — they reply
  via BizBot's **Conversations** tab (with the per-chat AI toggle).
- **Display name changes** need Meta review and are limited (~not more than about once a
  month) — do them in WhatsApp Manager, not BizBot.
- You (operator) pay Meta for messages; track spend in the admin **WhatsApp spend** tile.
