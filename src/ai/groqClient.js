import 'dotenv/config'

export const GROQ_API_KEY = process.env.GROQ_API_KEY
// Model options (free tier):
//  - llama-3.3-70b-versatile  → best quality, 1,000 req/day  (recommended for replies)
//  - llama-3.1-8b-instant     → fastest, 14,400 req/day      (max volume)
export const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

export function hasValidGroqKey() {
  return Boolean(GROQ_API_KEY && !GROQ_API_KEY.includes('REPLACE') && GROQ_API_KEY.length >= 10)
}

// ── Call Groq (OpenAI-compatible chat completions) ────
export async function callGroq(systemPrompt, history, userMessage, attempt = 1) {
  const messages = [{ role: 'system', content: systemPrompt }]
  for (const msg of history) {
    messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content })
  }
  messages.push({ role: 'user', content: userMessage })

  const response = await fetch(GROQ_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      messages,
      max_tokens:  400,
      temperature: 0.7,
    })
  })

  const data = await response.json()

  if (!response.ok) {
    if (response.status === 429 && attempt <= 3) {
      const retryAfter = response.headers.get('retry-after')
      const waitMs = retryAfter ? (parseFloat(retryAfter) + 1) * 1000 : attempt * 2000
      console.warn(`⏳ Groq rate limited. Retry ${attempt}/3 in ${waitMs/1000}s...`)
      await sleep(waitMs)
      return callGroq(systemPrompt, history, userMessage, attempt + 1)
    }
    console.error('❌ Groq error:', JSON.stringify(data?.error))
    throw new Error(data?.error?.message || `HTTP ${response.status}`)
  }

  return data?.choices?.[0]?.message?.content || null
}
