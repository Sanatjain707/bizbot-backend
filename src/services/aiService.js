// Thin orchestrator: save inbound → build prompt + windowed history →
// call Groq → save outbound → let the conversation coordinator decide
// whether to touch appointments/payments. No booking logic lives here.

import 'dotenv/config'
import { saveMessage, getHistoryWindow } from '../config/database.js'
import { buildPrompt } from '../ai/prompt/index.js'
import { callGroq, GROQ_API_KEY, GROQ_MODEL, hasValidGroqKey } from '../ai/groqClient.js'
import { tryExtractAppointment } from '../ai/conversationManager.js'
import { resolveDateTime } from '../utils/dateResolver.js'
import { formatTime12 } from '../utils/dateTime.js'
export { appointmentReminder, paymentReminder, reengagementMessage } from '../ai/messageTemplates.js'

const RECENT_WINDOW = 6
const LOOKBACK      = 40

// Roll older messages into a compact one-line-per-turn summary. Keeps context
// alive without paying full-content tokens for every past message.
function summarizeOlder(older) {
  if (!older?.length) return null
  const lines = older.map(m => {
    const who = m.role === 'assistant' ? 'Bot' : 'Cust'
    const trimmed = String(m.content || '').replace(/\s+/g, ' ').slice(0, 100)
    return `- ${who}: ${trimmed}`
  })
  return `EARLIER CONVERSATION (summary of older turns):\n${lines.join('\n')}`
}

// If the customer's current message contains a resolvable date/time, hand
// the LLM the resolved values so it doesn't have to do date math.
function resolveNote(userMessage) {
  const r = resolveDateTime(userMessage)
  if (!r.date && !r.time) return null
  const parts = []
  if (r.date) parts.push(`date "${r.datePhrase}" → ${r.date}${r.weekday ? ` (${r.weekday})` : ''}`)
  if (r.time) parts.push(`time "${r.timePhrase}" → ${r.time} (${formatTime12(r.time)})`)
  return `BACKEND-RESOLVED FROM CUSTOMER MESSAGE (use these exact values, do not re-parse):\n- ${parts.join('\n- ')}`
}

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
    const { recent, older } = await getHistoryWindow(customer.id, RECENT_WINDOW, LOOKBACK)
    const basePrompt   = buildPrompt(business)
    const summary      = summarizeOlder(older)
    const resolvedNote = resolveNote(userMessage)
    const systemPrompt = [basePrompt, summary, resolvedNote].filter(Boolean).join('\n\n')

    console.log(`📤 Calling Groq (${GROQ_MODEL})...`)
    const reply = await callGroq(systemPrompt, recent, userMessage)
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
