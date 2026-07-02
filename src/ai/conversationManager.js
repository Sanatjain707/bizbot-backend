import {
  createAppointment, updateCustomerName, getUpcomingAppointmentForCustomer,
  rescheduleAppointment, cancelAppointment
} from '../config/database.js'
import { classifyAppointmentIntent } from './intentClassifier.js'
import { tryCreatePayment } from './paymentManager.js'
import {
  isNonBookingIntent, parseAppointmentDateTime, shouldCancelAppointment,
  shouldExtractAppointment
} from './validator.js'

// ── Handle appointment actions: cancel, reschedule, new + payment ──
export async function tryExtractAppointment(business, customer, userMsg, aiReply) {
  // ── Cancellation ──
  if (shouldCancelAppointment(aiReply)) {
    const existing = await getUpcomingAppointmentForCustomer(customer.id)
    if (existing) {
      await cancelAppointment(existing.id)
      console.log('🗑️  Appointment cancelled')
    }
    return
  }

  // ── Only proceed for confirmations ──
  if (!shouldExtractAppointment(aiReply)) return

  try {
    const parsed = await classifyAppointmentIntent(userMsg, aiReply)
    if (!parsed) return
    console.log(`📋 Appointment classifier intent: ${parsed.intent || 'unknown'}`)

    // ── Ignore status questions and non-booking intents ──
    if (isNonBookingIntent(parsed.intent)) {
      console.log('ℹ️ Status query / non-booking — no appointment change')
      return
    }

    const dt = parseAppointmentDateTime(parsed)
    if (!dt) {
      if (parsed.date || parsed.time) console.warn('⚠️ Invalid date/time:', parsed.date, parsed.time)
      return
    }

    // Save the name if we just learned it
    if (parsed.name && !customer.name) await updateCustomerName(customer.id, parsed.name)

    const existing = await getUpcomingAppointmentForCustomer(customer.id)

    // ── Reschedule: update existing instead of creating duplicate ──
    if (parsed.intent === 'reschedule' && existing) {
      await rescheduleAppointment(existing.id, dt.toISOString())
      console.log('🔄 Appointment rescheduled')
      return
    }

    // ── Duplicate guard: same time already booked? skip ──
    if (existing) {
      const sameTime = Math.abs(new Date(existing.appointment_time).getTime() - dt.getTime()) < 60000
      if (sameTime) {
        console.log('ℹ️ Identical appointment already exists — skipping duplicate')
        return
      }
      // If they have an upcoming one and this looks like the same service, treat as reschedule
      if (existing.service === parsed.service) {
        await rescheduleAppointment(existing.id, dt.toISOString())
        console.log('🔄 Updated existing appointment')
        return
      }
    }

    // ── New appointment ──
    await createAppointment({
      business_id:      business.id,
      customer_id:      customer.id,
      service:          parsed.service || 'Appointment',
      appointment_time: dt.toISOString(),
      status:           'confirmed',
      reminder_sent:    false
    })
    console.log('📅 ✅ Appointment saved')

    // ── Auto-create a pending payment for the service price ──
    await tryCreatePayment(business, customer, parsed.service)

  } catch (err) {
    console.error('⚠️ Appointment handling failed:', err.message)
  }
}
