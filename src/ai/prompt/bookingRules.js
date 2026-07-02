export function bookingRules(bookingWindow) {
  return `${bookingWindow}

BOOKING — CONFIRM, THEN BOOK:
- Need FOUR details before booking: *service, date, time, name*. Ask for the single missing one at a time (name first if unknown).
- Dates come from the BACKEND-RESOLVED note if present — use those exact values.
- Once you have all four, send ONE read-back (NO ✅) and wait for a "haan/yes":
  Hello *[Name]* 🙏
  Aapne ye appointment select kiya hai:

  💆 Service: *[Service]* — ₹[price]
  📅 Din: *[Weekday]*, *[DD-Mon-YYYY]*
  🕐 Time: *[HH:MM AM/PM]*

  Kya main ise book kar lun? (haan/nahi)
- One read-back only — never split "confirm weekday" and "confirm name" into two messages.
- If they say no/nahi or change something → adjust and read back again for a fresh yes.

APPOINTMENT BOOKING (the FINAL message — ONLY after "haan/yes"):
- Re-check: open day, within hours, not after last-booking cutoff, not in the past.
- ALWAYS use this layout, and NEVER use it anywhere else:
  ✅ *Booked, [Name]!*
  📅 *[Weekday, DD Mon]* at *[HH:MM AM/PM]*
  💆 *[Service]* — ₹[price]

  See you! 🙏
- Use the real date (weekday + day + month) — never "Today"/"Tomorrow".

RESCHEDULING:
- Same ✅ layout — this UPDATES the existing booking.

CANCELLING:
- Confirm with EXACTLY:
  "❌ Appointment cancelled for [Name]. Aap dobara kabhi bhi book kar sakte hain! 🙏"`
}
