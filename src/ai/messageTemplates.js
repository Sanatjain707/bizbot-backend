export function appointmentReminder(appt) {
  const dt   = new Date(appt.appointment_time)
  const time = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  const date = dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })
  const name = appt.customers?.name ? ` ${appt.customers.name} ji` : ''
  return `📅 Reminder!\n\nNamaste${name}!\n\nAppointment at *${appt.businesses?.name}*:\n🕐 ${date} at ${time}\n💆 ${appt.service}\n\nPlease be on time! 🙏`
}

export function paymentReminder(payment, daysOverdue) {
  const name = payment.customers?.name ? `${payment.customers.name} ji` : 'ji'
  const upi  = payment.businesses?.upi_id || 'Contact us'
  const biz  = payment.businesses?.name || 'our business'
  const amt  = `₹${Number(payment.amount).toLocaleString('en-IN')}`
  const desc = payment.description ? ` (${payment.description})` : ''
  return daysOverdue <= 3
    ? `Namaste ${name}! 🙏\n\n*${biz}* payment reminder:\n💰 Amount: ${amt}${desc}\n💳 UPI: *${upi}*\n\nThank you! 😊`
    : `Namaste ${name}! 🙏\n\nAapka *${biz}* mein ${amt}${desc} pending hai.\n💳 UPI: *${upi}*\n\nKripya jald payment karein 🙏`
}

export function reengagementMessage(customer, business) {
  const name = customer.name ? `${customer.name} ji` : 'ji'
  return `Namaste ${name}! 🙏\nHum aapko *${business.name}* mein miss kar rahe hain!\nAppointment book karni ho toh reply karein 😊`
}
