# WhatsApp Onboarding SOP (per client — Model A)

Repeatable steps to put a client's WhatsApp on BizBot when their number lives
under **your** WABA. Do this once per client.

## One-time (yours, before any client)
- [ ] Meta **Business Manager** created.
- [ ] Meta **App** with the **WhatsApp** product added.
- [ ] A **WABA** (WhatsApp Business Account) under your Business.
- [ ] A **System User** with a **permanent access token** → this is your `WHATSAPP_TOKEN`.
- [ ] A **payment method** added on the WhatsApp account (needed for paid/marketing/utility
      template messages; service replies in-window are free).
- [ ] **Business Verification** submitted (needed to scale past the starter limits).
- [ ] App **webhook** configured once → `https://<backend>/webhook`, subscribed to
      **messages** + **message_status**. This covers every number under the WABA.

## Per client
1. **Number** — get a phone number for the client that is **not** signed in to the regular
   WhatsApp / WhatsApp Business app. Either a new dedicated number, or free up their
   existing one (delete its WhatsApp account first). It must receive an SMS/voice OTP.
2. **Add the number** — WhatsApp Manager → your WABA → **Add phone number** → enter it →
   verify with the **OTP**.
3. **Display name** (the business name shown on chats) — set it to the client's business
   name and **submit for Meta name review**. Must match the real business + follow Meta's
   display-name rules. Usually approved quickly; changes later trigger re-review.
4. **Business Profile** — WhatsApp Manager → the phone number → **Profile**:
   - Upload the **logo** (profile photo — square image).
   - Fill **about/description, category, address, hours, email, website**.
   - (Optional: this can also be done via Cloud API `POST /{phone-number-id}/whatsapp_business_profile`.)
5. **Connect to BizBot** — copy the number's **Phone number ID** and paste it into the
   client's business: **Admin → Clients → [client] → whatsapp_phone_id** (or the client's
   Settings). If the client is on their own WABA, also store `waba_id`.
6. **Mark live** — in the admin console set WABA status to **live** for that client.
7. **Test** — message the number → confirm the AI replies and a booking works end-to-end.
   The client's **display name + logo** now show on every customer chat.

## Notes
- Display name review and profile edits are done in **WhatsApp Manager**, not in BizBot.
- The client can no longer use the normal WhatsApp app on that number — they reply via
  the BizBot **Conversations** tab (with the per-chat AI toggle) instead.
- You (the operator) pay Meta for messages and bill the client — watch the cost in the
  admin **WhatsApp spend** tile.
