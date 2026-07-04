// IST-anchored date/time helpers.
// The DB stores everything as timestamptz (UTC on the wire). Business logic
// runs on India Standard Time. Every function here treats IST as the source
// of truth so the backend behaves identically regardless of server timezone.

const IST_OFFSET_MINUTES = 5 * 60 + 30
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000

// Current wall-clock time in IST as a Date whose UTC methods return IST values.
// Useful for downstream code that only wants to `.getHours()` / `.getDay()`.
export function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS)
}

// "YYYY-MM-DD" in IST for a given Date (defaults to now).
export function istDateStr(d = new Date()) {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS)
  return shifted.toISOString().slice(0, 10)
}

// UTC ISO string for IST midnight on a given IST date (YYYY-MM-DD).
export function istMidnightUtc(istDateString) {
  return new Date(`${istDateString}T00:00:00+05:30`).toISOString()
}

// UTC ISO string for IST 23:59:59.999 on a given IST date.
export function istEndOfDayUtc(istDateString) {
  return new Date(`${istDateString}T23:59:59.999+05:30`).toISOString()
}

// Add N days to a "YYYY-MM-DD" string. Pure string math, no TZ concerns.
export function addDaysISO(istDateString, days) {
  const [y, m, d] = istDateString.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

// 0 = Mon, 1 = Tue, ..., 6 = Sun (matches business_hours keys mon/tue/…)
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export function dayKeyFromISO(istDateString) {
  const [y, m, d] = istDateString.split('-').map(Number)
  // JS getUTCDay: 0 = Sun … 6 = Sat. Map to Mon-anchored index.
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const monAnchored = (jsDay + 6) % 7
  return DAY_KEYS[monAnchored]
}

// Combine an IST date (YYYY-MM-DD) + time (HH:MM) into a UTC ISO string
// suitable for the appointment_time column.
export function istDateTimeToUtcISO(istDateString, hhmm) {
  return new Date(`${istDateString}T${hhmm}:00+05:30`).toISOString()
}

// Format a UTC ISO into a human "Fri, 12 Jul at 4:00 PM" string in IST.
export function formatISTHuman(utcISO) {
  const d = new Date(utcISO)
  const date = d.toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
  })
  const time = d.toLocaleTimeString('en-IN', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  })
  return `${date} at ${time}`
}

// "HH:MM" (24h) → "H:MM AM/PM"
export function formatTime12(hhmm) {
  if (!hhmm || typeof hhmm !== 'string' || !hhmm.includes(':')) return null
  const [hStr, mStr] = hhmm.split(':')
  const h = parseInt(hStr, 10)
  const m = parseInt(mStr, 10)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

// "HH:MM" → minutes since midnight
export function hhmmToMinutes(hhmm) {
  if (!hhmm || !hhmm.includes(':')) return null
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}
