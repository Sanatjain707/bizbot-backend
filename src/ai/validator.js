export function shouldCancelAppointment(aiReply) {
  return aiReply.includes('❌') && aiReply.toLowerCase().includes('cancel')
}

export function shouldExtractAppointment(aiReply) {
  return aiReply.includes('✅')
}

export function isNonBookingIntent(intent) {
  return intent === 'query' || intent === 'other'
}

export function parseAppointmentDateTime(parsed) {
  if (!parsed.date || !parsed.time) return null
  const dt = new Date(`${parsed.date}T${parsed.time}:00`)
  return isNaN(dt.getTime()) ? null : dt
}
