import 'dotenv/config'
import { saveMessage, getHistory } from '../config/database.js'
import { buildPrompt } from '../ai/prompt/index.js'
import { callGroq, GROQ_API_KEY, GROQ_MODEL, hasValidGroqKey } from '../ai/groqClient.js'
import { tryExtractAppointment } from '../ai/conversationManager.js'
export { appointmentReminder, paymentReminder, reengagementMessage } from '../ai/messageTemplates.js'

// ── Main message processor ────────────────────────────
export async function processMessage(business, customer, userMessage) {
  await saveMessage(business.id, customer.id, 'user', userMessage)

  console.log('🔑 GROQ_API_KEY status:', GROQ_API_KEY ? 'Found' : 'NOT FOUND — check .env file')

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

    console.log('✅ Groq replied')
    return reply

  } catch (err) {
    console.error('❌ Groq call failed:', err.message)
    const fallback = 'Namaste! 🙏 Abhi ek technical issue hai. Thodi der mein reply karenge. Sorry!'
    await saveMessage(business.id, customer.id, 'assistant', fallback)
    return fallback
  }
}
