import { callGroq } from './groqClient.js'

function parseClassifierJson(raw) {
  try {
    return JSON.parse(String(raw).replace(/```json|```/gi, '').trim())
  } catch (err) {
    console.warn('⚠️ Appointment classifier returned invalid JSON:', err.message)
    return null
  }
}

export async function classifyAppointmentIntent(userMsg, aiReply) {
  const today    = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const todayStr    = today.toISOString().split('T')[0]
  const tomorrowStr = tomorrow.toISOString().split('T')[0]

  const extractPrompt = `Today's date is ${todayStr}.

Analyze this WhatsApp conversation.
Return ONLY raw JSON, absolutely no markdown, no backticks, no explanation.

Customer said: "${userMsg}"
Bot replied: "${aiReply}"

First decide the INTENT:
- "book"      = customer is making a NEW booking
- "reschedule"= customer is changing the time of an existing booking
- "query"     = customer is just ASKING about an existing appointment (when is it, what time, etc) — NOT booking
- "other"     = none of the above

Rules for dates/times (only if booking or reschedule):
- "Today"/"aaj" → "${todayStr}", "Tomorrow"/"kal" → "${tomorrowStr}"
- Time to 24hr HH:MM (3:15 PM = 15:15, 10 AM = 10:00)
- "12-Jun-2026" → "2026-06-12"
- A date with no year (e.g. "Fri, 12 Jun" or "12 Jun") → use the nearest such date that is today or later (use next year only if it already passed this year)

Return exactly:
{"intent":"book|reschedule|query|other","service":"name","date":"YYYY-MM-DD","time":"HH:MM","name":"full name"}

If intent is "query" or "other", set service/date/time/name to empty strings.`

  const result = await callGroq('You are a JSON intent classifier. Return only raw JSON, no markdown.', [], extractPrompt, {
    maxTokens: 180,
    temperature: 0,
  })
  if (!result) return null

  return parseClassifierJson(result)
}
