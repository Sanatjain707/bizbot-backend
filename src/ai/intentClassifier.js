// Intent classifier. Now a lightweight fallback — the backend dateResolver
// is the source of truth for dates/times. The classifier's real job is to
// distinguish book/reschedule/query/other and to pull service + customer name.
// Date/time are still asked-for so we have a hint when the resolver misses.

import { callGroq } from './groqClient.js'
import { addDaysISO, istDateStr } from '../utils/dateTime.js'

function parseClassifierJson(raw) {
  try {
    return JSON.parse(String(raw).replace(/```json|```/gi, '').trim())
  } catch (err) {
    console.warn('⚠️ Appointment classifier returned invalid JSON:', err.message)
    return null
  }
}

export async function classifyAppointmentIntent(userMsg, aiReply) {
  const todayStr    = istDateStr()
  const tomorrowStr = addDaysISO(todayStr, 1)

  const extractPrompt = `Today (IST) is ${todayStr}.

Analyze this WhatsApp conversation.
Return ONLY raw JSON, absolutely no markdown, no backticks, no explanation.

Customer said: "${userMsg}"
Bot replied: "${aiReply}"

INTENT:
- "book"       = customer is making a NEW booking
- "reschedule" = customer is changing an existing booking
- "query"     = customer is ASKING about an existing appointment (not booking)
- "other"     = none of the above

Date/time hints (only if book or reschedule) — the backend re-resolves dates,
so best-effort is fine:
- "Today"/"aaj" → "${todayStr}", "Tomorrow"/"kal" → "${tomorrowStr}"
- Time to 24hr HH:MM (3:15 PM = 15:15)
- A date with no year → the nearest such date that is today or later

Return exactly:
{"intent":"book|reschedule|query|other","service":"name","date":"YYYY-MM-DD","time":"HH:MM","name":"full name"}

If intent is "query" or "other", set service/date/time/name to empty strings.`

  const result = await callGroq(
    'You are a JSON intent classifier. Return only raw JSON, no markdown.',
    [],
    extractPrompt,
    { maxTokens: 180, temperature: 0 },
  )
  if (!result) return null
  return parseClassifierJson(result)
}
