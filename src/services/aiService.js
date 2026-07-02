import 'dotenv/config'
import {
  saveMessage, getHistory, createAppointment, updateCustomerName,
  getUpcomingAppointmentForCustomer, rescheduleAppointment, cancelAppointment,
  createPayment
} from '../config/database.js'

const GROQ_API_KEY = process.env.GROQ_API_KEY
// Model options (free tier):
//  - llama-3.3-70b-versatile  → best quality, 1,000 req/day  (recommended for replies)
//  - llama-3.1-8b-instant     → fastest, 14,400 req/day      (max volume)
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions'

function formatServices(business) {
  const list = business.services_list
  if (Array.isArray(list) && list.length > 0) {
    // One bulleted line per service (WhatsApp-friendly), grouped by category
    const byCat = {}
    for (const s of list) {
      const cat = s.category || 'Services'
      if (!byCat[cat]) byCat[cat] = []
      let line = `• ${s.name} — ₹${s.price}`
      if (s.duration) line += ` (${s.duration})`
      if (s.details)  line += ` — ${s.details}`
      byCat[cat].push(line)
    }
    const cats = Object.entries(byCat)
    // Single default category → plain bullet list; multiple → bold category headers
    if (cats.length === 1 && cats[0][0] === 'Services') return cats[0][1].join('\n')
    return cats.map(([cat, items]) => `*${cat}*\n${items.join('\n')}`).join('\n\n')
  }
  // Fallback to old text fields
  return `${business.services || 'Ask owner'}\nPricing: ${business.pricing || 'Contact for pricing'}`
}

function formatHours(business) {
  const h = business.business_hours
  if (h && typeof h === 'object' && Object.keys(h).length) {
    const names = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun' }
    const order = ['mon','tue','wed','thu','fri','sat','sun']
    const parts = []
    for (const d of order) {
      const day = h[d]
      if (!day) continue
      if (day.closed) parts.push(`${names[d]}: Closed`)
      else parts.push(`${names[d]}: ${day.open}-${day.close}`)
    }
    if (parts.length) return parts.join(', ')
  }
  // fallback to old free-text field
  return business.working_hours || '9am-8pm Mon-Sat'
}

// "16:30" → "4:30 PM". Returns null when no last booking time is set.
function formatLastBooking(business) {
  const raw = business.last_booking_time
  if (!raw || typeof raw !== 'string' || !raw.includes(':')) return null
  const [hStr, mStr] = raw.split(':')
  const h = parseInt(hStr, 10), m = parseInt(mStr, 10)
  if (isNaN(h) || isNaN(m)) return null
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

function buildPrompt(business) {
  const lastBooking = formatLastBooking(business)
  // Example-backed rules hold better than bare rules. The cutoff lines only
  // appear when a last booking time is set; the closed-day rule always applies.
  const bookingWindow = `BOOKING WINDOW (follow strictly when offering OR accepting a slot):
- Only offer or confirm slots inside the working hours listed above.
- NEVER offer or confirm a slot on a day marked "Closed" — suggest the nearest open day instead.${lastBooking ? `
- The LAST booking time is ${lastBooking}. NEVER offer or accept any slot later than ${lastBooking}, even on days that close later.
- If a customer asks for a time after ${lastBooking}, politely decline and offer ${lastBooking} (or an earlier open slot).` : ''}

Examples:${lastBooking ? `
- Customer asks for a slot after ${lastBooking}: "Sorry ji, hamari last booking ${lastBooking} tak hoti hai 🙏 ${lastBooking} chalega? 😊"` : ''}
- Customer asks for a day that is marked Closed: "Us din hum band rehte hain 🙏 [nearest open day] ko aa sakte hain? 😊"`

  return `You are BizBot, the AI WhatsApp assistant for "${business.name}" — a ${business.type || 'service business'} in India.

BUSINESS DETAILS:
SERVICES & PRICES:
${formatServices(business)}

- Hours: ${formatHours(business)}
- Location: ${business.location || 'Contact for address'}${business.landmark ? ` (Landmark: ${business.landmark})` : ''}${business.maps_link ? `\n- Map link (share when customers ask for directions): ${business.maps_link}` : ''}
- Owner: ${business.owner_name || 'The owner'}
- UPI: ${business.upi_id || 'Ask owner'}
${business.ai_instructions ? `\nSPECIAL INSTRUCTIONS:\n${business.ai_instructions}` : ''}

YOUR RULES:
1. Match the customer's language AND tone. Hinglish → Hinglish, plain English → plain English, terse → terse. Don't force flowery Hinglish on someone typing short English.
2. Keep every reply SHORT and skimmable — answer what was asked + at most ONE next step. Never dump the whole menu + hours + booking prompt in one message.
3. Never claim to be a human.
4. Never invent prices or services not listed above. If unsure: "Main owner ko inform kar deta hoon 🙏"
5. One emoji per message, max — warm, not cluttered. EXCEPTION: the booking confirmation layout uses ✅ 📅 💆 🙏 as its structure — ALWAYS keep those icons, never strip them.
6. Only offer slots within working hours, on open days, and no later than the last booking time (see BOOKING WINDOW below).

WHATSAPP FORMATTING (messages must be easy to read on a phone):
- Show ANY list (services, options) as separate lines each starting with "• " — NEVER as a comma-separated sentence.
- Put a blank line between logical blocks (greeting / list / question).
- *Bold* the important bits: prices, times, service names, confirmations.
- Once you've shown the services, don't re-list them every message — just refer to the one(s) being discussed.
- If there are more than 6 services, DON'T list them all in the greeting. Show 5-6 popular/representative ones, then a line like "...aur bhi hain, poochho! 😊". You still know the full menu, so answer accurately if they ask about any specific service.

Example — customer says "Hi":
Namaste! 🙏 Aapka swagat hai.

Hamari services:
• Facial — *₹4000*
• Hairwash — *₹800*
• Pedicure — *₹1000*

Kaunsi service lena chahenge?

Example — customer asks "facial kitne ka?":
Facial *₹4000* ka hai 😊 Kis din aana chahenge?
(Short: answers what was asked + one next step. No full menu re-dump.)

CONVERSATION FLOW:
- First message from a new customer: short warm greeting + the bulleted services list + ask which service.
- When they pick a service: confirm it with its *price*, then ask their preferred day & time. Don't list opening hours unless they ask.
- Ask for only ONE missing detail at a time — e.g. ask their name, THEN the time — not everything at once.
- Once you have service + day + time + name, confirm the booking (see APPOINTMENT BOOKING).
- AFTER confirming: one short line offering advance payment via UPI (${business.upi_id || 'ask owner'}) or pay at the visit.

HANDLING TRICKY MESSAGES:
- Off-topic / something you don't offer → politely steer back, don't make up an answer: "Yeh toh hum nahi karte 🙏 par apni services mein help kar sakte hain!"
- Vague price like "kitne ka?" with no service named → ask which one, don't guess: "Kis service ka? 😊"
- Several questions in one message → answer them all, each on its own line.
- If the customer is rude or testing you → stay calm and professional, keep helping.

⚠️ CRITICAL — only use the ✅ booking confirmation layout when ACTUALLY booking a NEW appointment or rescheduling.
- If the customer ASKS ABOUT an existing appointment (e.g. "meri appointment kab ki hai?", "when is my appointment?", "what time is my booking?"), DO NOT use the ✅ layout. Just tell them in plain words like: "Aapki appointment [date] ko [time] baje [service] ke liye hai 😊" — NO ✅ symbol.
- Never use the ✅ layout to answer a question. Only use it to confirm a brand-new booking or a reschedule.

${bookingWindow}

APPOINTMENT BOOKING:
- Before confirming, make sure the slot is on an open day, within working hours, and not after the last booking time (see BOOKING WINDOW).
- When confirming a NEW booking, ALWAYS keep the ✅ and use this scannable layout:
  ✅ *Booked, [Name]!*
  📅 *[Weekday, DD Mon]* at *[HH:MM AM/PM]*
  💆 *[Service]* — ₹[price]

  See you! 🙏
- Example:
  ✅ *Booked, Priya!*
  📅 *Fri, 12 Jun* at *3:15 PM*
  💆 *Facial* — ₹4000

  See you! 🙏
- ALWAYS use a real date as weekday + day + month (e.g. "Fri, 12 Jun") — NEVER "Today" or "Tomorrow".

RESCHEDULING:
- If a customer reschedules, confirm the NEW time using the SAME ✅ layout above.
- This UPDATES their existing booking — don't treat it as a brand new one.

CANCELLING:
- If customer wants to cancel, confirm with EXACTLY:
  "❌ Appointment cancelled for [Name]. Aap dobara kabhi bhi book kar sakte hain! 🙏"

Always be warm and helpful.`
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Call Groq (OpenAI-compatible chat completions) ────
async function callGroq(systemPrompt, history, userMessage, attempt = 1) {
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

// ── Main message processor ────────────────────────────
export async function processMessage(business, customer, userMessage) {
  await saveMessage(business.id, customer.id, 'user', userMessage)

  console.log('🔑 GROQ_API_KEY status:', GROQ_API_KEY
    ? `Found (${GROQ_API_KEY.slice(0, 8)}...)`
    : 'NOT FOUND — check .env file'
  )

  if (!GROQ_API_KEY || GROQ_API_KEY.includes('REPLACE') || GROQ_API_KEY.length < 10) {
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

// ── Handle appointment actions: cancel, reschedule, new + payment ──
async function tryExtractAppointment(business, customer, userMsg, aiReply) {
  // ── Cancellation ──
  if (aiReply.includes('❌') && aiReply.toLowerCase().includes('cancel')) {
    const existing = await getUpcomingAppointmentForCustomer(customer.id)
    if (existing) {
      await cancelAppointment(existing.id)
      console.log(`🗑️  Appointment cancelled for ${customer.name || customer.phone}`)
    }
    return
  }

  // ── Only proceed for confirmations ──
  if (!aiReply.includes('✅')) return

  try {
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

    const result = await callGroq('You are a JSON intent classifier. Return only raw JSON, no markdown.', [], extractPrompt)
    if (!result) return

    const parsed = JSON.parse(result.replace(/```json|```/gi, '').trim())
    console.log('📋 Extraction result:', parsed)

    // ── Ignore status questions and non-booking intents ──
    if (parsed.intent === 'query' || parsed.intent === 'other') {
      console.log('ℹ️ Status query / non-booking — no appointment change')
      return
    }
    if (!parsed.date || !parsed.time) return

    const dt = new Date(`${parsed.date}T${parsed.time}:00`)
    if (isNaN(dt.getTime())) {
      console.warn('⚠️ Invalid date/time:', parsed.date, parsed.time)
      return
    }

    // Save the name if we just learned it
    if (parsed.name && !customer.name) await updateCustomerName(customer.id, parsed.name)

    const existing = await getUpcomingAppointmentForCustomer(customer.id)

    // ── Reschedule: update existing instead of creating duplicate ──
    if (parsed.intent === 'reschedule' && existing) {
      await rescheduleAppointment(existing.id, dt.toISOString())
      console.log(`🔄 Appointment rescheduled to ${parsed.date} ${parsed.time}`)
      return
    }

    // ── Duplicate guard: same time already booked? skip ──
    if (existing) {
      const sameTime = Math.abs(new Date(existing.appointment_time).getTime() - dt.getTime()) < 60000
      if (sameTime) {
        console.log('ℹ️ Identical appointment already exists — skipping duplicate')
        return
      }
      // If they have an upcoming one and this looks like the same service, treat as reschedule
      if (existing.service === parsed.service) {
        await rescheduleAppointment(existing.id, dt.toISOString())
        console.log(`🔄 Updated existing ${parsed.service} appointment`)
        return
      }
    }

    // ── New appointment ──
    await createAppointment({
      business_id:      business.id,
      customer_id:      customer.id,
      service:          parsed.service || 'Appointment',
      appointment_time: dt.toISOString(),
      status:           'confirmed',
      reminder_sent:    false
    })
    console.log(`📅 ✅ Appointment saved: ${parsed.service} on ${parsed.date} at ${parsed.time}`)

    // ── Auto-create a pending payment for the service price ──
    await tryCreatePayment(business, customer, parsed.service)

  } catch (err) {
    console.error('⚠️ Appointment handling failed:', err.message)
  }
}

// ── Create a payment record when a service price is known ──
async function tryCreatePayment(business, customer, serviceName) {
  if (!serviceName) return
  try {
    let amount = 0

    // 1. Try structured services_list first (exact match, no AI needed)
    if (Array.isArray(business.services_list)) {
      const match = business.services_list.find(
        s => s.name?.toLowerCase().trim() === serviceName.toLowerCase().trim()
      )
      if (match?.price) amount = Number(match.price)
    }

    // 2. Fallback to AI extraction from old pricing text
    if (!amount && business.pricing) {
      const pricePrompt = `Price list: "${business.pricing}"
Service booked: "${serviceName}"
Return ONLY the numeric price (digits only) for that service. If not found, return 0. No text, no symbol.`
      const priceRaw = await callGroq('You extract a single number. Return only digits.', [], pricePrompt)
      amount = parseInt(String(priceRaw).replace(/\D/g, '')) || 0
    }

    if (!amount || amount <= 0) return

    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 1)

    await createPayment({
      business_id:   business.id,
      customer_id:   customer.id,
      amount,
      description:   serviceName,
      due_date:      dueDate.toISOString(),
      status:        'pending',
      reminder_sent: false
    })
    console.log(`💰 Payment record created: ₹${amount} for ${serviceName}`)
  } catch (err) {
    console.error('⚠️ Payment creation skipped:', err.message)
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