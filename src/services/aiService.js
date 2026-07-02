import 'dotenv/config'
import { saveMessage, getHistory } from '../config/database.js'
import { buildPrompt } from '../ai/prompt/index.js'
import { callGroq, GROQ_API_KEY, GROQ_MODEL, hasValidGroqKey } from '../ai/groqClient.js'
import { tryExtractAppointment } from '../ai/conversationManager.js'

// ── Main message processor ────────────────────────────
export async function processMessage(business, customer, userMessage) {
  await saveMessage(business.id, customer.id, 'user', userMessage)

  console.log('🔑 GROQ_API_KEY status:', GROQ_API_KEY
    ? `Found (${GROQ_API_KEY.slice(0, 8)}...)`
    : 'NOT FOUND — check .env file'
  )

  if (!hasValidGroqKey()) {
    const fallback = 'Namaste! 🙏 AI setup ho raha hai. Thodi der mein reply karenge!'
    await saveMessage(business.id, customer.id, 'assistant', fallback)
    return fallback
  }

  try {
    const history = await getHistory(customer.id, 10)
    const prompt  = buildPrompt(business)

    console.log(`📤 Calling Groq (${GROQ_MODEL})...`)
    const reply = await callGroq(prompt, history, userMessage)
    if (!reply) throw new Error('Empty response from Groq')

    await saveMessage(business.id, customer.id, 'assistant', reply)
    await tryExtractAppointment(business, customer, userMessage, reply)

    console.log(`✅ Groq replied: ${reply.slice(0, 80)}...`)
    return reply

  } catch (err) {
    console.error('❌ Groq call failed:', err.message)
    const fallback = 'Namaste! 🙏 Abhi ek technical issue hai. Thodi der mein reply karenge. Sorry!'
    await saveMessage(business.id, customer.id, 'assistant', fallback)
    return fallback
  }
}

// ── Message builders ──────────────────────────────────
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
