import 'dotenv/config'
import axios from 'axios'
import { supabase, normalizePhone } from '../config/database.js'
import { getTemplateById, varCount } from './templateService.js'

const GRAPH = 'https://graph.facebook.com/v19.0'
// Approx Meta marketing message cost in India (₹). Adjust as Meta's rates change.
const COST_PER_MSG = 0.78

// ── Resolve which customers a segment targets ─────────
export async function resolveAudience(businessId, segment, segmentValue) {
  let q = supabase.from('customers').select('id, phone, name, last_seen, opted_out')
    .eq('business_id', businessId).eq('opted_out', false)

  const { data: all } = await q
  let list = all || []

  const now = Date.now()
  if (segment === 'active') {
    list = list.filter(c => (now - new Date(c.last_seen).getTime()) < 14 * 86400000)
  } else if (segment === 'lapsed') {
    list = list.filter(c => (now - new Date(c.last_seen).getTime()) >= 21 * 86400000)
  } else if (segment === 'service' && segmentValue) {
    // customers who have an appointment for this service
    const { data: appts } = await supabase.from('appointments')
      .select('customer_id').eq('business_id', businessId).ilike('service', `%${segmentValue}%`)
    const ids = new Set((appts || []).map(a => a.customer_id))
    list = list.filter(c => ids.has(c.id))
  }
  return list
}

export function estimateCost(count) {
  return Math.round(count * COST_PER_MSG * 100) / 100
}

// ── Create a campaign (draft) ─────────────────────────
export async function createCampaign(businessId, { name, template_id, segment, segment_value, scheduled_at }) {
  const audience = await resolveAudience(businessId, segment, segment_value)
  const { data, error } = await supabase.from('campaigns').insert({
    business_id: businessId, name, template_id,
    segment: segment || 'all', segment_value: segment_value || null,
    status: scheduled_at ? 'scheduled' : 'draft',
    scheduled_at: scheduled_at || null,
    total: audience.length,
    est_cost: estimateCost(audience.length),
  }).select().single()
  return { campaign: data, audienceCount: audience.length, error }
}

// ── Build the WhatsApp template payload ───────────────
// Every {{n}} in the template MUST get a parameter or Meta rejects the send
// with a count mismatch. Convention for broadcasts: body {{1}} = the customer's
// name; {{2}}.. and the header variable = the template's stored example values
// (broadcast constants like an offer or amount).
function buildTemplatePayload(toPhone, template, customer) {
  const ex = template.variable_examples || {}
  const nHeader = varCount(template.header)
  const nBody   = varCount(template.body)
  const components = []

  if (nHeader > 0) {
    components.push({ type: 'header', parameters: [{ type: 'text', text: String(ex.header || ' ') }] })
  }
  if (nBody > 0) {
    const params = []
    for (let i = 1; i <= nBody; i++) {
      const text = i === 1 ? (customer.name || 'there') : (ex.body?.[i - 1] || ' ')
      params.push({ type: 'text', text: String(text) })
    }
    components.push({ type: 'body', parameters: params })
  }

  return {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language || 'en' },
      ...(components.length ? { components } : {}),
    },
  }
}

// ── Send a campaign now ───────────────────────────────
export async function sendCampaign(business, campaignId) {
  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).eq('business_id', business.id).single()
  if (!campaign) throw new Error('Campaign not found')

  const template = await getTemplateById(campaign.template_id)
  if (!template) throw new Error('Template not found')
  if (template.status !== 'APPROVED') throw new Error('Template is not approved yet')

  // Atomically claim the campaign — only proceed if it's still draft/scheduled.
  // Prevents a double-send from a double-click or a scheduler+manual overlap.
  const { data: claimed } = await supabase.from('campaigns')
    .update({ status: 'sending' })
    .eq('id', campaignId).in('status', ['draft', 'scheduled']).select('id')
  if (!claimed || !claimed.length) return { skipped: true, reason: 'already sending or sent' }

  const audience = await resolveAudience(business.id, campaign.segment, campaign.segment_value)
  const phoneId  = business.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID
  let sent = 0, failed = 0

  for (const customer of audience) {
    const phone = normalizePhone(customer.phone)
    try {
      const payload = buildTemplatePayload(phone, template, customer)
      const res = await axios.post(`${GRAPH}/${phoneId}/messages`, payload, {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      })
      const waMsgId = res.data?.messages?.[0]?.id
      await supabase.from('campaign_recipients').insert({
        campaign_id: campaignId, customer_id: customer.id, phone,
        wa_message_id: waMsgId, status: 'sent',
      })
      sent++
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message
      await supabase.from('campaign_recipients').insert({
        campaign_id: campaignId, customer_id: customer.id, phone,
        status: 'failed', error: msg,
      })
      failed++
    }
  }

  await supabase.from('campaigns').update({
    status: 'sent', sent, failed, total: audience.length,
    sent_at: new Date().toISOString(),
  }).eq('id', campaignId)

  return { sent, failed, total: audience.length }
}

// ── List campaigns with analytics ─────────────────────
export async function listCampaigns(businessId) {
  const { data } = await supabase.from('campaigns')
    .select('*, templates(name)').eq('business_id', businessId)
    .order('created_at', { ascending: false })
  return data || []
}

// ── Pre-send validation (fast, synchronous) ───────────
// Lets the route give immediate feedback before backgrounding the actual blast.
export async function validateCampaignSendable(businessId, campaignId) {
  const { data: c } = await supabase.from('campaigns').select('*').eq('id', campaignId).eq('business_id', businessId).single()
  if (!c) return { error: 'Campaign not found' }
  if (!['draft', 'scheduled'].includes(c.status)) return { error: `Campaign is already ${c.status}` }
  const t = await getTemplateById(c.template_id)
  if (!t) return { error: 'Template not found' }
  if (t.status !== 'APPROVED') return { error: 'Template is not approved yet' }
  const audience = await resolveAudience(businessId, c.segment, c.segment_value)
  return { error: null, total: audience.length }
}

// ── Cancel a draft/scheduled campaign ─────────────────
export async function cancelCampaign(businessId, campaignId) {
  const { data } = await supabase.from('campaigns')
    .update({ status: 'cancelled' })
    .eq('id', campaignId).eq('business_id', businessId).in('status', ['draft', 'scheduled']).select('id')
  if (!data || !data.length) return { error: 'Only a draft or scheduled campaign can be cancelled' }
  return { error: null }
}

// ── Update recipient + campaign counters from a status webhook ──
export async function applyStatusUpdate(waMessageId, newStatus) {
  // newStatus: sent | delivered | read
  const { data: rec } = await supabase.from('campaign_recipients')
    .select('*').eq('wa_message_id', waMessageId).single()
  if (!rec) return

  // Only move forward (sent → delivered → read)
  const rank = { queued: 0, sent: 1, delivered: 2, read: 3, replied: 4, failed: 1 }
  if ((rank[newStatus] || 0) <= (rank[rec.status] || 0)) return

  await supabase.from('campaign_recipients')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', rec.id)

  // Recompute campaign counters
  await recomputeCounters(rec.campaign_id)
}

export async function markReplied(customerId) {
  // If a customer who received a recent campaign replies, count it
  const { data: rec } = await supabase.from('campaign_recipients')
    .select('*').eq('customer_id', customerId).order('updated_at', { ascending: false }).limit(1).single()
  if (rec && rec.status !== 'replied') {
    await supabase.from('campaign_recipients').update({ status: 'replied' }).eq('id', rec.id)
    await recomputeCounters(rec.campaign_id)
  }
}

async function recomputeCounters(campaignId) {
  const { data: recs } = await supabase.from('campaign_recipients')
    .select('status').eq('campaign_id', campaignId)
  if (!recs) return
  const c = { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 }
  for (const r of recs) {
    if (r.status === 'failed') c.failed++
    else {
      // cumulative — read implies delivered+sent
      if (['sent','delivered','read','replied'].includes(r.status)) c.sent++
      if (['delivered','read','replied'].includes(r.status)) c.delivered++
      if (['read','replied'].includes(r.status)) c.read++
      if (r.status === 'replied') c.replied++
    }
  }
  await supabase.from('campaigns').update(c).eq('id', campaignId)
}