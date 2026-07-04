// Booking service — owns creation/reschedule/cancel of appointments.
// Every write path goes through validateBooking(), so an invalid slot can
// never be persisted regardless of what the LLM said.

import {
  cancelAppointment as dbCancel,
  createAppointment as dbCreate,
  getUpcomingAppointmentForCustomer,
  rescheduleAppointment as dbReschedule,
} from '../config/database.js'
import { validateBooking, findService } from '../ai/validator.js'
import { istDateTimeToUtcISO } from '../utils/dateTime.js'

export async function getUpcoming(customerId) {
  return getUpcomingAppointmentForCustomer(customerId)
}

// Attempt to create a new appointment.
// Returns { created, appointment?, reason?, code? }.
export async function createBooking({ business, customer, dateISO, hhmm, service }) {
  const check = await validateBooking({ business, customer, dateISO, hhmm, service })
  if (!check.valid) return { created: false, reason: check.error, code: check.code }

  const matchedService = findService(business, service)
  const appt = await dbCreate({
    business_id:      business.id,
    customer_id:      customer.id,
    service:          matchedService?.name || service || 'Appointment',
    appointment_time: check.resolved.appointment_time,
    status:           'confirmed',
    reminder_sent:    false,
  })
  return { created: true, appointment: appt, service: matchedService }
}

// Reschedule the customer's next upcoming appointment.
export async function rescheduleBooking({ business, customer, dateISO, hhmm, service }) {
  const existing = await getUpcomingAppointmentForCustomer(customer.id)
  if (!existing) return { rescheduled: false, code: 'no_existing_booking' }

  const check = await validateBooking({
    business, customer, dateISO, hhmm,
    service: service || existing.service,
  })
  if (!check.valid) return { rescheduled: false, reason: check.error, code: check.code }

  const appt = await dbReschedule(existing.id, check.resolved.appointment_time)
  return { rescheduled: true, appointment: appt }
}

export async function cancelUpcoming(customerId) {
  const existing = await getUpcomingAppointmentForCustomer(customerId)
  if (!existing) return { cancelled: false, code: 'no_existing_booking' }
  await dbCancel(existing.id)
  return { cancelled: true, appointment: existing }
}

// Convenience: build the appointment_time UTC ISO from an IST slot without
// running the full validator — used only by places that already validated.
export function toAppointmentTime(dateISO, hhmm) {
  return istDateTimeToUtcISO(dateISO, hhmm)
}
