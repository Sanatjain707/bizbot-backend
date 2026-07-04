import { CronJob } from 'cron'
import { getUpcomingForReminder, markReminderSent, getOverduePayments, markPaymentReminderSent, saveMessage, supabase } from '../config/database.js'
import { sendMessage } from '../services/whatsappService.js'
import { appointmentReminder, paymentReminder } from '../services/aiService.js'
import { detectLanguage } from '../ai/messageTemplates.js'
import { sendCampaign } from '../services/campaignService.js'
import { isPlanActive } from '../services/billingService.js'

// Pick the customer's language from their most recent inbound message.
// Cheap: one query per reminder recipient, and reminders are hourly.
async function customerLang(customerId) {
  const { data } = await supabase.from('messages')
    .select('content')
    .eq('customer_id', customerId).eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(1)
  return detectLanguage(data?.[0]?.content || '')
}

export function startCronJobs() {
  // Appointment reminders — hourly
  new CronJob('0 * * * *', async () => {
    console.log('⏰ Running appointment reminders...')
    const appts = await getUpcomingForReminder(24)
    for (const appt of appts) {
      const phone = appt.customers?.phone, phoneId = appt.businesses?.whatsapp_phone_id
      if (!phone || !phoneId) continue
      // Mark reminder as "in flight" BEFORE sending. If the process dies
      // between send and mark, worst case is a missed reminder rather than
      // a double-send. WhatsApp doesn't have idempotency keys on this API
      // so preventing dupes has to happen on our side.
      await markReminderSent(appt.id)
      const lang = await customerLang(appt.customer_id)
      const msg = appointmentReminder(appt, lang)
      const res = await sendMessage(phone, msg, phoneId)
      if (res.success) await saveMessage(appt.business_id, appt.customer_id, 'assistant', msg)
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
      // Same "mark before send" pattern as appointment reminders — avoids
      // double-sends when Meta accepts but our commit fails afterwards.
      await markPaymentReminderSent(p.id)
      const lang = await customerLang(p.customer_id)
      const msg = paymentReminder(p, days, lang)
      const res = await sendMessage(phone, msg, phoneId)
      if (res.success) await saveMessage(p.business_id, p.customer_id, 'assistant', msg)
    }
  }, null, true)

  // Scheduled broadcasts — every minute, send any campaign whose time has come.
  new CronJob('* * * * *', async () => {
    const { data: due } = await supabase.from('campaigns')
      .select('*, businesses(*)')
      .eq('status', 'scheduled')
      .lte('scheduled_at', new Date().toISOString())
    for (const camp of due || []) {
      const business = camp.businesses
      if (!business) continue
      // The manual send route is plan-gated; the cron must enforce it too.
      if (!isPlanActive(business)) { console.log(`Scheduled campaign ${camp.id} skipped — plan inactive`); continue }
      try { await sendCampaign(business, camp.id) }
      catch (err) { console.error(`Scheduled campaign ${camp.id} failed:`, err.message) }
    }
  }, null, true)

  console.log('⏰ Cron jobs started: reminders (hourly) · payments (10am) · scheduled broadcasts (every minute)')
}