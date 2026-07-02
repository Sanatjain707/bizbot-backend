// Conversation coordinator. Only decides *what* to do (book / reschedule /
// cancel / nothing); the actual work is delegated to bookingService and
// paymentService. Date resolution runs on the backend (dateResolver), not
// the LLM — the classifier is only used as a hint when the resolver misses.

import { updateCustomerName } from '../config/database.js'
import { classifyAppointmentIntent } from './intentClassifier.js'
import { isNonBookingIntent, shouldCancelAppointment, shouldExtractAppointment } from './validator.js'
import {
  cancelUpcoming,
  createBooking,
  getUpcoming,
  rescheduleBooking,
} from '../services/bookingService.js'
import { tryCreatePayment } from '../services/paymentService.js'
import { resolveDateTime } from '../utils/dateResolver.js'

// ── Reconcile the backend resolver with the classifier ──
// Backend resolver is authoritative for dates; classifier fills in the gaps
// (mostly service name and the "reschedule vs book" intent).
function mergeSlot(userMsg, classified) {
  const resolved = resolveDateTime(userMsg)
  return {
    intent:  classified?.intent || 'book',
    service: classified?.service || null,
    name:    classified?.name || null,
    date:    resolved.date || classified?.date || null,
    time:    resolved.time || classified?.time || null,
    source:  { resolved, classified },
  }
}

// Returns one of:
//   { status: 'ignored' }               — nothing to do (no markers, non-booking intent)
//   { status: 'cancelled' }
//   { status: 'created' | 'rescheduled', service }
//   { status: 'rejected', code, reason, slot } — validator refused; caller
//     should send a correction WhatsApp message so the ✅ the LLM already
//     sent doesn't stand.
export async function tryExtractAppointment(business, customer, userMsg, aiReply) {
  if (shouldCancelAppointment(aiReply)) {
    const result = await cancelUpcoming(customer.id)
    if (result.cancelled) console.log('🗑️  Appointment cancelled')
    return { status: 'cancelled' }
  }

  if (!shouldExtractAppointment(aiReply)) return { status: 'ignored' }

  try {
    const classified = await classifyAppointmentIntent(userMsg, aiReply)
    if (!classified) return { status: 'ignored' }
    console.log(`📋 Appointment classifier intent: ${classified.intent || 'unknown'}`)

    if (isNonBookingIntent(classified.intent)) {
      console.log('ℹ️ Status query / non-booking — no appointment change')
      return { status: 'ignored' }
    }

    const slot = mergeSlot(userMsg, classified)
    if (!slot.date || !slot.time) {
      console.warn('⚠️ Booking skipped — missing date/time after resolver+classifier merge:', slot.date, slot.time)
      return { status: 'ignored' }
    }

    if (slot.name && !customer.name) await updateCustomerName(customer.id, slot.name)

    if (slot.intent === 'reschedule') {
      const existing = await getUpcoming(customer.id)
      if (existing) {
        const r = await rescheduleBooking({
          business, customer, dateISO: slot.date, hhmm: slot.time, service: slot.service,
        })
        if (r.rescheduled) { console.log('🔄 Appointment rescheduled'); return { status: 'rescheduled' } }
        console.warn(`⚠️ Reschedule rejected (${r.code}): ${r.reason}`)
        return { status: 'rejected', code: r.code, reason: r.reason, slot }
      }
    }

    const existing = await getUpcoming(customer.id)
    if (existing && existing.service === slot.service) {
      const r = await rescheduleBooking({
        business, customer, dateISO: slot.date, hhmm: slot.time, service: slot.service,
      })
      if (r.rescheduled) { console.log('🔄 Updated existing appointment'); return { status: 'rescheduled' } }
      console.warn(`⚠️ Update rejected (${r.code}): ${r.reason}`)
      return { status: 'rejected', code: r.code, reason: r.reason, slot }
    }

    const created = await createBooking({
      business, customer, dateISO: slot.date, hhmm: slot.time, service: slot.service,
    })
    if (!created.created) {
      console.warn(`⚠️ Booking rejected (${created.code}): ${created.reason}`)
      return { status: 'rejected', code: created.code, reason: created.reason, slot }
    }
    console.log('📅 ✅ Appointment saved')

    await tryCreatePayment(business, customer, slot.service)
    return { status: 'created', service: slot.service }

  } catch (err) {
    console.error('⚠️ Appointment handling failed:', err.message)
    return { status: 'ignored' }
  }
}
