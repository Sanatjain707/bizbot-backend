import { Router } from 'express'
import { parseWebhook, sendMessage, markRead } from '../services/whatsappService.js'
import { processMessage } from '../services/aiService.js'
import { getBusinessByPhoneId, getOrCreateCustomer, getCustomerAIEnabled, saveMessage, supabase } from '../config/database.js'
import { applyStatusUpdate, markReplied } from '../services/campaignService.js'
import { isPlanActive } from '../services/billingService.js'

export const whatsappRouter = Router()

whatsappRouter.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified')
    return res.status(200).send(challenge)
  }
  res.sendStatus(403)
})

const STOP_WORDS = ['stop', 'unsubscribe', 'band karo', 'band karein', 'mat bhejo', 'opt out']

whatsappRouter.post('/', async (req, res) => {
  res.sendStatus(200)
  const msg = parseWebhook(req.body)
  if (!msg) return

  // ── Status update (sent/delivered/read) for campaign analytics ──
  if (msg.isStatus) {
    try {
      if (msg.status === 'sent' || msg.status === 'delivered' || msg.status === 'read') {
        await applyStatusUpdate(msg.waMessageId, msg.status)
      }
    } catch (e) { /* ignore */ }
    return
  }

  const userText = msg.text || msg.buttonReply
  if (!userText) {
    await sendMessage(msg.fromPhone, 'Namaste! 🙏 Abhi sirf text messages handle kar sakte hain. Please text mein likhen!', msg.phoneId)
    return
  }
  try {
    await markRead(msg.messageId, msg.phoneId)
    const business = await getBusinessByPhoneId(msg.phoneId)
    if (!business) { console.warn(`No business for phone_id: ${msg.phoneId}`); return }
    const customer = await getOrCreateCustomer(business.id, msg.fromPhone, msg.customerName)
    console.log(`💬 [${business.name}] ${msg.fromPhone}: ${userText}`)

    // ── Opt-out handling (STOP) ──
    if (STOP_WORDS.some(w => userText.toLowerCase().trim() === w || userText.toLowerCase().includes(w))) {
      await supabase.from('customers').update({ opted_out: true }).eq('id', customer.id)
      await saveMessage(business.id, customer.id, 'user', userText)
      await sendMessage(msg.fromPhone, 'Aap successfully unsubscribe ho gaye hain. Aapko ab promotional messages nahi milenge. 🙏', msg.phoneId)
      console.log(`🚫 ${msg.fromPhone} opted out`)
      return
    }

    // ── Mark campaign reply (if they recently got a broadcast) ──
    markReplied(customer.id).catch(() => {})

    // ── PLAN LOCK: if trial/plan expired, AI stops replying (core value gated) ──
    if (!isPlanActive(business)) {
      await saveMessage(business.id, customer.id, 'user', userText)
      console.log(`🔒 Plan expired for ${business.name} — AI paused, message saved only`)
      return
    }

    // Check if AI is enabled for this customer
    const aiEnabled = await getCustomerAIEnabled(customer.id)
    if (!aiEnabled) {
      await saveMessage(business.id, customer.id, 'user', userText)
      console.log(`⏸️  AI paused for ${msg.fromPhone} — saved, awaiting manual reply`)
      return
    }

    const reply = await processMessage(business, customer, userText)
    await sendMessage(msg.fromPhone, reply, msg.phoneId)
  } catch (err) {
    console.error('Webhook error:', err.message)
  }
})