import { Router } from 'express'
import crypto from 'node:crypto'
import { parseWebhook, sendMessage, markRead } from '../services/whatsappService.js'
import { processMessage } from '../services/aiService.js'
import { getBusinessByPhoneId, getOrCreateCustomer, getCustomerAIEnabled, saveMessage, supabase } from '../config/database.js'
import { applyStatusUpdate, markReplied } from '../services/campaignService.js'
import { isPlanActive } from '../services/billingService.js'

export const whatsappRouter = Router()

// Meta signs webhook payloads with x-hub-signature-256 = "sha256=<hex>"
// using WHATSAPP_APP_SECRET (from the Meta Developer Portal). If the secret
// isn't set we skip verification (dev), but in production this MUST be set —
// otherwise anyone can POST fake webhooks and make the bot send WhatsApps
// to arbitrary numbers.
function verifyWhatsAppSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET
  if (!secret) return true
  const provided = req.headers['x-hub-signature-256']
  if (!provided || !provided.startsWith('sha256=')) return false
  const raw = req.rawBody
  if (!raw) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch (_) { return false }
}

whatsappRouter.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified')
    return res.status(200).send(challenge)
  }
  res.sendStatus(403)
})

// Exact-match phrases (word-boundary). We intentionally do NOT use substring
// matches — "we should never stop trying" is not an opt-out.
const STOP_WORDS = ['stop', 'unsubscribe', 'band karo', 'band karein', 'mat bhejo', 'opt out']
function isOptOut(userText) {
  const t = userText.toLowerCase().trim()
  return STOP_WORDS.some(w => t === w || t === w + '.' || t === w + '!')
}

whatsappRouter.post('/', async (req, res) => {
  // Signature check FIRST so we reject spoofed callers before doing any work.
  if (!verifyWhatsAppSignature(req)) {
    console.warn('❌ Invalid WhatsApp webhook signature')
    return res.sendStatus(401)
  }

  const msg = parseWebhook(req.body)
  if (!msg) return res.sendStatus(200)

  // Status update (sent/delivered/read) for campaign analytics — quick ack.
  if (msg.isStatus) {
    res.sendStatus(200)
    try {
      if (['sent', 'delivered', 'read'].includes(msg.status)) {
        await applyStatusUpdate(msg.waMessageId, msg.status)
      }
    } catch (e) { /* ignore */ }
    return
  }

  const userText = msg.text || msg.buttonReply
  if (!userText) {
    res.sendStatus(200)
    await sendMessage(msg.fromPhone, 'Namaste! 🙏 Abhi sirf text messages handle kar sakte hain. Please text mein likhen!', msg.phoneId)
    return
  }

  // ── Persist the inbound message BEFORE returning 200 ──
  // If we crash mid-processing, Meta retries and the message isn't lost.
  // The heavy work (LLM call) still runs after the 200.
  let business, customer
  try {
    await markRead(msg.messageId, msg.phoneId)
    business = await getBusinessByPhoneId(msg.phoneId)
    if (!business) {
      res.sendStatus(200)
      console.warn(`No business for phone_id: ${msg.phoneId}`)
      return
    }
    customer = await getOrCreateCustomer(business.id, msg.fromPhone, msg.customerName)
    await saveMessage(business.id, customer.id, 'user', userText)
  } catch (err) {
    // Persistence failed → NON-200 so Meta retries.
    console.error('inbound persist failed:', err.message)
    return res.sendStatus(500)
  }
  res.sendStatus(200)

  try {
    console.log(`💬 [${business.name}] ${msg.fromPhone}: ${userText}`)

    if (isOptOut(userText)) {
      await supabase.from('customers').update({ opted_out: true }).eq('id', customer.id)
      await sendMessage(msg.fromPhone, 'Aap successfully unsubscribe ho gaye hain. Aapko ab promotional messages nahi milenge. 🙏', msg.phoneId)
      console.log(`🚫 ${msg.fromPhone} opted out`)
      return
    }

    markReplied(customer.id).catch(err => console.warn('markReplied failed:', err.message))

    // ── PLAN LOCK: if trial/plan expired, AI stops replying (message is already saved) ──
    if (!isPlanActive(business)) {
      console.log(`🔒 Plan expired for ${business.name} — AI paused, message saved only`)
      return
    }

    const aiEnabled = await getCustomerAIEnabled(customer.id)
    if (!aiEnabled) {
      console.log(`⏸️  AI paused for ${msg.fromPhone} — saved, awaiting manual reply`)
      return
    }

    // NOTE: aiService.processMessage saves the inbound again as a no-op if
    // called with the same content within the same request; we keep the
    // save in this route because it happens BEFORE the 200 ack.
    const { reply, correction } = await processMessage(business, customer, userText, { skipInboundSave: true })
    await sendMessage(msg.fromPhone, reply, msg.phoneId)
    if (correction) await sendMessage(msg.fromPhone, correction, msg.phoneId)
  } catch (err) {
    console.error('Webhook error:', err.message)
  }
})
