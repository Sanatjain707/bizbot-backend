// Deterministic date/time resolver for customer messages.
//
// The backend — not the LLM — owns date resolution. Given a raw user message
// ("kal shaam 4 baje", "Friday at 3pm", "12 July"), this returns the best
// candidate date + time in IST, ready for the validator. If the customer
// message is ambiguous we return whatever we found (date-only or time-only)
// and let the caller decide whether to ask a clarifying question.
//
// Covers: English + Hindi/Hinglish day names, relative words, explicit dates
// (12/7, 12-Jul-2026, 12 July), and time expressions ("shaam 4 baje", "4pm",
// "16:00", "3:30 PM"). English-only NL parsing (chrono-node style) doesn't
// cover the Hindi vocabulary that Indian customers actually type.

import { addDaysISO, dayKeyFromISO, hhmmToMinutes, istDateStr, nowIST } from './dateTime.js'

// ── Day-of-week vocab ─────────────────────────────────
// Mon-anchored index (0 = Mon … 6 = Sun) matches dayKeyFromISO output.
const DAY_WORDS = {
  monday: 0, mon: 0, somvar: 0, somwar: 0, somvaar: 0,
  tuesday: 1, tue: 1, tues: 1, mangalvar: 1, mangalwar: 1, mangal: 1,
  wednesday: 2, wed: 2, budhvar: 2, budhwar: 2, budh: 2,
  thursday: 3, thu: 3, thurs: 3, guruvar: 3, guruwar: 3, brihaspati: 3,
  friday: 4, fri: 4, shukravar: 4, shukrawar: 4, shukra: 4, jumma: 4,
  saturday: 5, sat: 5, shanivar: 5, shaniwar: 5, shani: 5,
  sunday: 6, sun: 6, ravivar: 6, raviwar: 6, ravi: 6, itwar: 6, itvaar: 6,
}

// ── Month vocab ───────────────────────────────────────
const MONTH_WORDS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

// ── Time-of-day vocab (approximate anchor when only a time-of-day word given) ─
// These bias which meridiem to pick for ambiguous numbers ("4 baje" → 4 PM if
// paired with "shaam", 4 AM if paired with "subah"). Ranges chosen from
// typical Indian usage — most salons/clinics open 9–8.
const TIME_OF_DAY = {
  subah: 'am', savere: 'am', morning: 'am',
  dopahar: 'pm', dopeher: 'pm', noon: 'pm', afternoon: 'pm',
  shaam: 'pm', shyaam: 'pm', evening: 'pm',
  raat: 'pm', night: 'pm',
}

// ── Relative words ────────────────────────────────────
const RELATIVE = {
  aaj: 0, today: 0,
  kal: 1, tomorrow: 1,   // "kal" is ambiguous in Hindi (yesterday OR tomorrow);
                          //  in a booking context we assume future.
  parson: 2, 'day after tomorrow': 2, 'day after': 2, 'dayaftertomorrow': 2,
  narson: 3,
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim()
}

// ── Public: resolve dates/times from a user message ───
// Returns { date: 'YYYY-MM-DD' | null, time: 'HH:MM' | null,
//           datePhrase, timePhrase, weekday: 'mon'|... | null }
export function resolveDateTime(message, referenceDate = null) {
  const text = ' ' + normalize(message) + ' '
  const refISO = referenceDate || istDateStr()

  const dateResult = resolveDate(text, refISO)
  const timeResult = resolveTime(text)

  return {
    date:        dateResult?.iso || null,
    time:        timeResult?.hhmm || null,
    datePhrase:  dateResult?.phrase || null,
    timePhrase:  timeResult?.phrase || null,
    weekday:     dateResult?.iso ? dayKeyFromISO(dateResult.iso) : null,
  }
}

// ── Date resolution ───────────────────────────────────
function resolveDate(text, refISO) {
  // 1. Relative words ("kal", "tomorrow", "parson")
  for (const [phrase, offset] of Object.entries(RELATIVE)) {
    const re = new RegExp(`\\b${phrase}\\b`)
    if (re.test(text)) return { iso: addDaysISO(refISO, offset), phrase }
  }

  // 2. Explicit numeric dates: dd/mm, dd-mm, dd/mm/yyyy, dd-mm-yyyy
  const numeric = text.match(/\b(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?\b/)
  if (numeric) {
    let [, dd, mm, yy] = numeric
    dd = parseInt(dd, 10); mm = parseInt(mm, 10)
    let year = yy ? parseInt(yy, 10) : null
    if (year && year < 100) year += 2000
    const iso = buildISO(year, mm, dd, refISO)
    if (iso) return { iso, phrase: numeric[0].trim() }
  }

  // 3. "12 Jul", "12 July", "12-Jul-2026", "July 12"
  //    a) day-first: "12 jul[y]" or "12-jul-2026"
  const dm = text.match(/\b(\d{1,2})[\s\-]([a-z]{3,9})(?:[\s\-](\d{2,4}))?\b/)
  if (dm) {
    const [, ddStr, monStr, yyStr] = dm
    const mm = MONTH_WORDS[monStr]
    if (mm) {
      let year = yyStr ? parseInt(yyStr, 10) : null
      if (year && year < 100) year += 2000
      const iso = buildISO(year, mm, parseInt(ddStr, 10), refISO)
      if (iso) return { iso, phrase: dm[0].trim() }
    }
  }
  //    b) month-first: "jul 12", "july 12"
  const md = text.match(/\b([a-z]{3,9})[\s\-](\d{1,2})(?:[\s\-,](\d{2,4}))?\b/)
  if (md) {
    const [, monStr, ddStr, yyStr] = md
    const mm = MONTH_WORDS[monStr]
    if (mm) {
      let year = yyStr ? parseInt(yyStr, 10) : null
      if (year && year < 100) year += 2000
      const iso = buildISO(year, mm, parseInt(ddStr, 10), refISO)
      if (iso) return { iso, phrase: md[0].trim() }
    }
  }

  // 4. Weekday names ("Friday", "shukravar", "agla shukravar")
  //    "agla"/"next" bumps a week if the plain weekday would fall today.
  const nextRe = /\b(agla|agle|next)\s+([a-z]{3,})/
  const nextMatch = text.match(nextRe)
  if (nextMatch && DAY_WORDS[nextMatch[2]] !== undefined) {
    const targetIdx = DAY_WORDS[nextMatch[2]]
    return { iso: nextWeekdayISO(refISO, targetIdx, true), phrase: nextMatch[0].trim() }
  }
  for (const [word, idx] of Object.entries(DAY_WORDS)) {
    const re = new RegExp(`\\b${word}\\b`)
    if (re.test(text)) return { iso: nextWeekdayISO(refISO, idx, false), phrase: word }
  }

  return null
}

function buildISO(year, mm, dd, refISO) {
  if (!mm || !dd || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  const [refY] = refISO.split('-').map(Number)
  let y = year
  if (!y) {
    // No year → prefer this year, roll to next year if the date is already past.
    const candidateThisYear = `${refY}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
    y = candidateThisYear < refISO ? refY + 1 : refY
  }
  const iso = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  // Sanity check: catch Feb 30 etc. Use UTC-anchored construction so the
  // day check isn't shifted by any timezone offset on the parsed value.
  const d = new Date(Date.UTC(y, mm - 1, dd))
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null
  return iso
}

// Nearest upcoming ISO date whose Mon-anchored weekday index equals `targetIdx`.
// If `forceNextWeek` is true, always advance at least 7 days (used for "next Friday").
function nextWeekdayISO(refISO, targetIdx, forceNextWeek) {
  for (let i = 0; i < 14; i++) {
    if (forceNextWeek && i < 7) continue
    const candidate = addDaysISO(refISO, i)
    const key = dayKeyFromISO(candidate)
    const idx = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(key)
    if (idx === targetIdx) return candidate
  }
  return null
}

// ── Time resolution ───────────────────────────────────
function resolveTime(text) {
  // Look for the time-of-day word first so we can bias meridiem for ambiguous
  // numeric times like "4 baje". "shaam" wins over "subah" if both appear.
  let bias = null
  let biasPhrase = null
  for (const [word, meridiem] of Object.entries(TIME_OF_DAY)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) { bias = meridiem; biasPhrase = word; break }
  }

  // Explicit 24h or 12h: "16:00", "4:30 pm", "4pm", "4 pm", "4:30"
  const explicit = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/)
  if (explicit) {
    const h  = parseInt(explicit[1], 10)
    const mn = explicit[2] ? parseInt(explicit[2], 10) : 0
    const meridiem = explicit[3].startsWith('a') ? 'am' : 'pm'
    const hhmm = to24h(h, mn, meridiem)
    if (hhmm) return { hhmm, phrase: explicit[0].trim() }
  }

  // "16:00" 24-hour with colon and no meridiem
  const hhmm = text.match(/\b([01]?\d|2[0-3]):(\d{2})\b/)
  if (hhmm) {
    const h  = parseInt(hhmm[1], 10)
    const mn = parseInt(hhmm[2], 10)
    if (mn < 60) return { hhmm: `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`, phrase: hhmm[0].trim() }
  }

  // "4 baje", "saade 4 baje" (half past 4), "sawa 4 baje" (quarter past)
  const bajeMatch = text.match(/\b(saade|sawa|paune)?\s*(\d{1,2})\s*baj[ea]\b/)
  if (bajeMatch) {
    const modifier = bajeMatch[1]
    let h = parseInt(bajeMatch[2], 10)
    let m = 0
    if (modifier === 'saade') m = 30
    else if (modifier === 'sawa') m = 15
    else if (modifier === 'paune') { h -= 1; m = 45 }
    const hhmm = to24h(h, m, bias || 'pm')
    if (hhmm) return { hhmm, phrase: bajeMatch[0].trim() }
  }

  // Bare number with a time-of-day word: "shaam 4", "subah 9"
  if (bias) {
    const bare = text.match(new RegExp(`\\b${biasPhrase}\\b[^\\d]{0,10}(\\d{1,2})(?::(\\d{2}))?\\b`))
    if (bare) {
      const h  = parseInt(bare[1], 10)
      const mn = bare[2] ? parseInt(bare[2], 10) : 0
      const hhmm = to24h(h, mn, bias)
      if (hhmm) return { hhmm, phrase: `${biasPhrase} ${bare[1]}${bare[2] ? ':' + bare[2] : ''}` }
    }
  }

  return null
}

function to24h(h, m, meridiem) {
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m >= 60) return null
  let hour = h
  if (meridiem === 'am') hour = h === 12 ? 0 : h
  else if (meridiem === 'pm') hour = h === 12 ? 12 : (h < 12 ? h + 12 : h)
  if (hour < 0 || hour > 23) return null
  return `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Exposed only for the classifier to sanity-check the model's output.
export { hhmmToMinutes }
