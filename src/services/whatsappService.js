import 'dotenv/config'
import axios from 'axios'

const BASE = 'https://graph.facebook.com/v19.0'
const TOKEN = () => process.env.WHATSAPP_TOKEN

export async function sendMessage(toPhone, text, phoneId) {
  const pid = phoneId || process.env.WHATSAPP_PHONE_ID
  try {
    await axios.post(`${BASE}/${pid}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: toPhone,
      type: 'text', text: { preview_url: false, body: text }
    }, { headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' } })
    console.log(`✅ WA sent → ${toPhone}: ${text.slice(0, 50)}...`)
    return { success: true }
  } catch (err) {
    console.error(`❌ WA failed → ${toPhone}:`, err.response?.data?.error?.message || err.message)
    // Meta error code lets callers tell a 24h-window rejection (131047) apart
    // from other failures (invalid number, not on WhatsApp, etc.)
    return { success: false, error: err.message, errorCode: err.response?.data?.error?.code }
  }
}

export async function markRead(msgId, phoneId) {
  const pid = phoneId || process.env.WHATSAPP_PHONE_ID
  try {
    await axios.post(`${BASE}/${pid}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: msgId }, { headers: { Authorization: `Bearer ${TOKEN()}` } })
  } catch (_) {}
}

export function parseWebhook(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value

    // Status updates (sent/delivered/read) for messages we sent — for campaign analytics
    if (value?.statuses?.length) {
      const s = value.statuses[0]
      return {
        isStatus: true,
        waMessageId: s.id,
        status: s.status,      // sent | delivered | read | failed
        pricing: s.pricing || null, // { billable, pricing_model, category } — Meta's actual billing
      }
    }

    if (!value?.messages?.length) return null
    const msg = value.messages[0]
    const contact = value.contacts?.[0]
    return {
      phoneId: value.metadata?.phone_number_id,
      fromPhone: msg.from, messageId: msg.id, type: msg.type,
      text: msg.type === 'text' ? msg.text?.body : null,
      buttonReply: msg.type === 'interactive' ? msg.interactive?.button_reply?.title : null,
      customerName: contact?.profile?.name || null
    }
  } catch (_) { return null }
}