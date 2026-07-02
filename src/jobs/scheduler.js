import { CronJob } from 'cron'
import { getUpcomingForReminder, markReminderSent, getOverduePayments, markPaymentReminderSent, saveMessage } from '../config/database.js'
import { sendMessage } from '../services/whatsappService.js'
import { appointmentReminder, paymentReminder } from '../services/aiService.js'

export function startCronJobs() {
  // Appointment reminders — hourly
  new CronJob('0 * * * *', async () => {
    console.log('⏰ Running appointment reminders...')
    const appts = await getUpcomingForReminder(24)
    for (const appt of appts) {
      const phone = appt.customers?.phone, phoneId = appt.businesses?.whatsapp_phone_id
      if (!phone || !phoneId) continue
      const msg = appointmentReminder(appt)
      const res = await sendMessage(phone, msg, phoneId)
      if (res.success) { await markReminderSent(appt.id); await saveMessage(appt.business_id, appt.customer_id, 'assistant', msg) }
    }
  }, null, true)

  // Payment follow-ups — daily 10am
  new CronJob('0 10 * * *', async () => {
    console.log('💰 Running payment follow-ups...')
    const payments = await getOverduePayments(1)
    for (const p of payments) {
      const phone = p.customers?.phone, phoneId = p.businesses?.whatsapp_phone_id
      if (!phone || !phoneId) continue
      const days = Math.floor((Date.now() - new Date(p.due_date).getTime()) / 86400000)
      // Respect each business's own reminder threshold (default 3 days)
      const threshold = Number(p.businesses?.payment_reminder_days) || 3
      if (days < threshold) continue
      const msg = paymentReminder(p, days)
      const res = await sendMessage(phone, msg, phoneId)
      if (res.success) { await markPaymentReminderSent(p.id); await saveMessage(p.business_id, p.customer_id, 'assistant', msg) }
    }
  }, null, true)

  console.log('⏰ Cron jobs started: reminders (hourly) · payments (10am)')
}