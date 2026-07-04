import { Router } from 'express'

export const demoRouter = Router()

const GROQ_API_KEY = process.env.GROQ_API_KEY
const GROQ_MODEL   = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions'

// Sample business for the public landing-page demo (no DB, no saving)
const DEMO_PROMPT = `You are BizBot, the AI WhatsApp assistant for "Priya Beauty Parlour", a sample beauty salon in Delhi.

BUSINESS DETAILS:
- Services: Haircut, Facial, Manicure, Pedicure, Threading, Hair Spa
- Pricing: Haircut ₹300, Facial ₹800, Manicure ₹500, Pedicure ₹600, Threading ₹50, Hair Spa ₹1200
- Hours: 9am-8pm, Monday to Saturday
- Location: Lajpat Nagar, New Delhi
- UPI: priyasalon@upi

RULES:
1. Reply in the SAME language the customer writes (Hindi, English, or Hinglish)
2. Keep replies SHORT — max 3-4 lines, this is WhatsApp
3. Use emojis naturally
4. This is a DEMO — if they book, confirm warmly but mention "Yeh ek demo hai — apne business ke liye BizBot try karein!"
5. Be warm, helpful, show off how good you are at handling customers

Goal: impress the visitor so they want BizBot for their own business.`

demoRouter.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body
  if (!message) return res.status(400).json({ error: 'message required' })

  if (!GROQ_API_KEY) {
    return res.json({ reply: 'Namaste! 🙏 Demo abhi setup ho raha hai. Real BizBot aapke business ke liye 24/7 ready rahega!' })
  }

  try {
    const messages = [{ role: 'system', content: DEMO_PROMPT }]
    for (const h of history.slice(-6)) {
      messages.push({ role: h.from === 'bot' ? 'assistant' : 'user', content: h.text })
    }
    messages.push({ role: 'user', content: message })

    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 300, temperature: 0.7 })
    })
    const data = await r.json()
    const reply = data?.choices?.[0]?.message?.content || 'Namaste! 🙏 Dobara try karein.'
    res.json({ reply })
  } catch (err) {
    console.error('Demo chat error:', err.message)
    res.json({ reply: 'Namaste! 🙏 Demo abhi busy hai — par real BizBot aapke liye ready rahega! 😊' })
  }
})

