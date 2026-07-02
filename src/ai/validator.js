// Booking validator — the source of truth for whether a proposed appointment
// can be persisted. Every rule the user surfaces to the LLM in prompts is
// re-enforced here so a bad LLM reply cannot corrupt the database.
//
// Public API:
//   validateBooking({ business, customer, dateISO, hhmm, service })
//     → { valid, error, code, resolved }
//
// Individual predicates are exported for reuse in tests or edge callers.

import { supabase } from '../config/database.js'
import {
  dayKeyFromISO, hhmmToMinutes, istDateStr,
  istDateTimeToUtcISO, nowIST,
} from '../utils/dateTime.js'

// ── LLM marker helpers (kept for the extractor's existing contract) ───
export function shouldCancelAppointment(aiReply) {
  return aiReply.includes('❌') && aiReply.toLowerCase().includes('cancel')
}

export function shouldExtractAppointment(aiReply) {
  return aiReply.includes('✅')
}

export function isNonBookingIntent(intent) {
  return intent === 'query' || intent === 'other'
}

// ── Service lookup (case/space-insensitive match against services_list) ──
export function findService(business, serviceName) {
  if (!serviceName) return null
  const list = Array.isArray(business?.services_list) ? business.services_list : []
  const target = serviceName.toLowerCase().trim()
  return list.find(s => (s.name || '').toLowerCase().trim() === target) || null
}

export function isValidService(business, serviceName) {
  if (!Array.isArray(business?.services_list) || business.services_list.length === 0) {
    // Business hasn't structured services yet — accept whatever the LLM extracted.
    return true
  }
  return !!findService(business, serviceName)
}

// ── Business-hours checks ─────────────────────────────
function dayConfig(business, dateISO) {
  const hours = business?.business_hours
  if (!hours || typeof hours !== 'object') return null
  return hours[dayKeyFromISO(dateISO)] || null
}

export function isBusinessOpen(business, dateISO) {
  // Holidays first — an entry in business.holidays overrides the weekly pattern.
  if (isHoliday(business, dateISO)) return false
  const day = dayConfig(business, dateISO)
  if (!day) return true            // no config → assume open (legacy free-text hours)
  return day.closed !== true
}

export function isWithinBusinessHours(business, dateISO, hhmm) {
  const day = dayConfig(business, dateISO)
  if (!day || day.closed) return false
  if (!day.open || !day.close) return true    // partial config → don't block
  const t = hhmmToMinutes(hhmm)
  const open = hhmmToMinutes(day.open)
  const close = hhmmToMinutes(day.close)
  if (t == null || open == null || close == null) return false
  return t >= open && t <= close
}

export function isAfterBookingCutoff(business, hhmm) {
  const cutoff = business?.last_booking_time
  if (!cutoff || typeof cutoff !== 'string') return false
  const t = hhmmToMinutes(hhmm)
  const c = hhmmToMinutes(cutoff)
  if (t == null || c == null) return false
  return t > c
}

export function isHoliday(business, dateISO) {
  const list = Array.isArray(business?.holidays) ? business.holidays : []
  return list.some(h => (typeof h === 'string' ? h : h?.date) === dateISO)
}

// ── Past date/time check (5-minute grace so a booking made "now" isn't rejected) ──
export function isPastDateTime(dateISO, hhmm) {
  const utcISO = istDateTimeToUtcISO(dateISO, hhmm)
  const proposed = new Date(utcISO).getTime()
  const nowMs = Date.now()
  return proposed < nowMs - 5 * 60 * 1000
}

// ── Duplicate: same customer, same time (±60s) already booked ──
export async function hasDuplicateBooking(customerId, dateTimeUtcISO) {
  const target = new Date(dateTimeUtcISO).getTime()
  const windowStart = new Date(target - 60_000).toISOString()
  const windowEnd   = new Date(target + 60_000).toISOString()
  const { data } = await supabase.from('appointments')
    .select('id')
    .eq('customer_id', customerId)
    .eq('status', 'confirmed')
    .gte('appointment_time', windowStart)
    .lte('appointment_time', windowEnd)
    .limit(1)
  return (data?.length || 0) > 0
}

// ── Conflict: any other confirmed appointment at the same business/time ──
// For single-chair businesses this catches double-books; multi-chair businesses
// can set `business.allow_overlap = true` to skip the check.
export async function hasConflictingBooking(businessId, dateTimeUtcISO, business = null) {
  if (business?.allow_overlap) return false
  const target = new Date(dateTimeUtcISO).getTime()
  const windowStart = new Date(target - 60_000).toISOString()
  const windowEnd   = new Date(target + 60_000).toISOString()
  const { data } = await supabase.from('appointments')
    .select('id')
    .eq('business_id', businessId)
    .eq('status', 'confirmed')
    .gte('appointment_time', windowStart)
    .lte('appointment_time', windowEnd)
    .limit(1)
  return (data?.length || 0) > 0
}

// ── Aggregate: run every check, return the first failure with a code the
// caller can turn into a customer-facing message. ──
export async function validateBooking({ business, customer, dateISO, hhmm, service }) {
  if (!dateISO || !hhmm) {
    return { valid: false, code: 'missing_datetime', error: 'Date or time missing' }
  }
  if (!isValidService(business, service)) {
    return { valid: false, code: 'unknown_service', error: `Service "${service}" not in list` }
  }
  if (isPastDateTime(dateISO, hhmm)) {
    return { valid: false, code: 'past_datetime', error: 'That time is in the past' }
  }
  if (!isBusinessOpen(business, dateISO)) {
    return { valid: false, code: isHoliday(business, dateISO) ? 'holiday' : 'closed_day', error: 'Business is closed that day' }
  }
  if (!isWithinBusinessHours(business, dateISO, hhmm)) {
    return { valid: false, code: 'outside_hours', error: 'Time is outside business hours' }
  }
  if (isAfterBookingCutoff(business, hhmm)) {
    return { valid: false, code: 'after_cutoff', error: 'Time is after last-booking cutoff' }
  }

  const utcISO = istDateTimeToUtcISO(dateISO, hhmm)
  if (customer?.id && await hasDuplicateBooking(customer.id, utcISO)) {
    return { valid: false, code: 'duplicate', error: 'Customer already booked this slot' }
  }
  if (business?.id && await hasConflictingBooking(business.id, utcISO, business)) {
    return { valid: false, code: 'conflict', error: 'Another appointment already at this time' }
  }

  return {
    valid:    true,
    resolved: { dateISO, hhmm, service, appointment_time: utcISO },
  }
}

// ── Legacy shim so any old callers keep compiling ─────
export function parseAppointmentDateTime(parsed) {
  if (!parsed?.date || !parsed?.time) return null
  const dt = new Date(`${parsed.date}T${parsed.time}:00+05:30`)
  return Number.isNaN(dt.getTime()) ? null : dt
}
