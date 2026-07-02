import {
  createAppointment, updateCustomerName, getUpcomingAppointmentForCustomer,
  rescheduleAppointment, cancelAppointment, createPayment
} from '../config/database.js'
import { callGroq } from './groqClient.js'
import { classifyAppointmentIntent } from './intentClassifier.js'
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
      console.log(`🗑️  Appointment cancelled for ${customer.name || customer.phone}`)
    }
    return
  }

  // ── Only proceed for confirmations ──
  if (!shouldExtractAppointment(aiReply)) return

  try {
    const parsed = await classifyAppointmentIntent(userMsg, aiReply)
    if (!parsed) return
    console.log('📋 Extraction result:', parsed)

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
      console.log(`🔄 Appointment rescheduled to ${parsed.date} ${parsed.time}`)
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
        console.log(`🔄 Updated existing ${parsed.service} appointment`)
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
    console.log(`📅 ✅ Appointment saved: ${parsed.service} on ${parsed.date} at ${parsed.time}`)

    // ── Auto-create a pending payment for the service price ──
    await tryCreatePayment(business, customer, parsed.service)

  } catch (err) {
    console.error('⚠️ Appointment handling failed:', err.message)
  }
}

// ── Create a payment record when a service price is known ──
async function tryCreatePayment(business, customer, serviceName) {
  if (!serviceName) return
  try {
    let amount = 0

    // 1. Try structured services_list first (exact match, no AI needed)
    if (Array.isArray(business.services_list)) {
      const match = business.services_list.find(
        s => s.name?.toLowerCase().trim() === serviceName.toLowerCase().trim()
      )
      if (match?.price) amount = Number(match.price)
    }

    // 2. Fallback to AI extraction from old pricing text
    if (!amount && business.pricing) {
      const pricePrompt = `Price list: "${business.pricing}"
Service booked: "${serviceName}"
Return ONLY the numeric price (digits only) for that service. If not found, return 0. No text, no symbol.`
      const priceRaw = await callGroq('You extract a single number. Return only digits.', [], pricePrompt)
      amount = parseInt(String(priceRaw).replace(/\D/g, '')) || 0
    }

    if (!amount || amount <= 0) return

    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 1)

    await createPayment({
      business_id:   business.id,
      customer_id:   customer.id,
      amount,
      description:   serviceName,
      due_date:      dueDate.toISOString(),
      status:        'pending',
      reminder_sent: false
    })
    console.log(`💰 Payment record created: ₹${amount} for ${serviceName}`)
  } catch (err) {
    console.error('⚠️ Payment creation skipped:', err.message)
  }
}
