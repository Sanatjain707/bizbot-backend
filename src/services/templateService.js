import 'dotenv/config'
import axios from 'axios'
import { supabase } from '../config/database.js'

const GRAPH = 'https://graph.facebook.com/v19.0'

// Meta needs the WhatsApp Business Account ID (WABA), not the phone id.
// Store it per business as `waba_id`, fall back to an env default for single-tenant testing.
function wabaId(business) {
  return business?.waba_id || process.env.WHATSAPP_WABA_ID
}

// Highest positional variable in a template string. "Hi {{1}}, {{2}} due" -> 2.
// Meta uses positional {{1}}..{{n}} and REQUIRES an example for each when the
// template is submitted — omitting them is an automatic rejection.
export function varCount(text) {
  let max = 0
  for (const m of String(text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]))
  return max
}

// ── Create a template on Meta + save locally as PENDING ──
export async function createTemplate(business, { name, category, language, body, header, footer, bodyExamples = [], headerExample = '' }) {
  // WhatsApp template names must be lowercase + underscores
  const safeName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60)

  const nBody = varCount(body)
  const nHeader = varCount(header)

  const components = []
  if (header) {
    const h = { type: 'HEADER', format: 'TEXT', text: header }
    // A TEXT header supports at most one variable ({{1}}).
    if (nHeader > 0) h.example = { header_text: [String(headerExample || '').trim() || 'Example'] }
    components.push(h)
  }
  const bodyComp = { type: 'BODY', text: body }
  if (nBody > 0) {
    // Meta wants a single example row: [[ex1, ex2, ...]] — one entry per {{n}}.
    const exs = []
    for (let i = 0; i < nBody; i++) exs.push(String(bodyExamples[i] || '').trim() || 'Example')
    bodyComp.example = { body_text: [exs] }
  }
  components.push(bodyComp)
  if (footer) components.push({ type: 'FOOTER', text: footer })

  let metaId = null, status = 'PENDING', rejectReason = null

  try {
    const waba = wabaId(business)
    if (waba && process.env.WHATSAPP_TOKEN) {
      const res = await axios.post(
        `${GRAPH}/${waba}/message_templates`,
        { name: safeName, category: category || 'MARKETING', language: language || 'en', components },
        { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
      )
      metaId = res.data?.id
      status = (res.data?.status || 'PENDING').toUpperCase()
    } else {
      // No WABA configured (local testing) — save as PENDING so the UI flow still works
      console.warn('⚠️ No WHATSAPP_WABA_ID set — template saved locally as PENDING (not sent to Meta)')
    }
  } catch (err) {
    const apiErr = err.response?.data?.error
    console.error('❌ Meta template create failed:', apiErr?.message || err.message)
    status = 'REJECTED'
    rejectReason = apiErr?.error_user_msg || apiErr?.message || 'Meta rejected the template'
  }

  const { data, error } = await supabase.from('templates').insert({
    business_id: business.id, name: safeName, category: category || 'MARKETING',
    language: language || 'en', body, header, footer,
    meta_template_id: metaId, status, reject_reason: rejectReason,
    variable_examples: { body: bodyExamples, header: headerExample },
  }).select().single()

  return { template: data, error }
}

// ── List templates for a business ─────────────────────
export async function listTemplates(businessId) {
  const { data } = await supabase.from('templates')
    .select('*').eq('business_id', businessId).order('created_at', { ascending: false })
  return data || []
}

// ── Sync ALL templates from Meta — import new ones + update statuses ──
export async function refreshTemplateStatuses(business) {
  const waba = wabaId(business)
  if (!waba || !process.env.WHATSAPP_TOKEN) return
  try {
    const res = await axios.get(`${GRAPH}/${waba}/message_templates`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      params: { limit: 200 },
    })
    const metaTemplates = res.data?.data || []

    // What we already have locally
    const { data: existing } = await supabase.from('templates')
      .select('id, name').eq('business_id', business.id)
    const byName = new Map((existing || []).map(t => [t.name, t.id]))

    for (const mt of metaTemplates) {
      // Extract body/header/footer + example values from Meta's components array
      let body = '', header = '', footer = '', bodyEx = [], headerEx = ''
      for (const c of (mt.components || [])) {
        if (c.type === 'BODY')   { body = c.text || ''; bodyEx = c.example?.body_text?.[0] || [] }
        if (c.type === 'HEADER' && c.format === 'TEXT') { header = c.text || ''; headerEx = c.example?.header_text?.[0] || '' }
        if (c.type === 'FOOTER') footer = c.text || ''
      }
      const status = (mt.status || 'PENDING').toUpperCase()
      const variable_examples = { body: bodyEx, header: headerEx }

      if (byName.has(mt.name)) {
        // Update status (and refresh content) of an existing row
        await supabase.from('templates')
          .update({ status, meta_template_id: mt.id, body: body || undefined, header, footer, variable_examples })
          .eq('id', byName.get(mt.name))
      } else {
        // Import a template that exists in Meta but not in BizBot
        await supabase.from('templates').insert({
          business_id: business.id,
          name: mt.name,
          category: (mt.category || 'MARKETING').toUpperCase(),
          language: mt.language || 'en',
          body, header, footer,
          meta_template_id: mt.id,
          status,
          variable_examples,
        })
      }
    }
  } catch (err) {
    console.error('Template sync failed:', err.response?.data?.error?.message || err.message)
  }
}

export async function getTemplateById(id) {
  const { data } = await supabase.from('templates').select('*').eq('id', id).single()
  return data
}

// ── Delete from both Meta AND local DB, scoped to the business ──
export async function deleteTemplate(business, templateId) {
  // 1. Fetch the template and verify it belongs to THIS business (multi-tenant guard)
  const { data: tpl } = await supabase.from('templates')
    .select('*').eq('id', templateId).eq('business_id', business.id).single()
  if (!tpl) return { error: 'Template not found for this business' }

  // 2. Block deletion if a campaign is actively using it
  const { data: activeCampaigns } = await supabase.from('campaigns')
    .select('id, status').eq('template_id', templateId)
    .in('status', ['scheduled', 'sending'])
  if (activeCampaigns && activeCampaigns.length > 0) {
    return { error: 'This template is being used by an active or scheduled campaign. Cancel that campaign first.' }
  }

  // 3. Delete from Meta (by name) — only if this business has its own WABA
  const waba = wabaId(business)
  if (waba && process.env.WHATSAPP_TOKEN) {
    try {
      await axios.delete(`${GRAPH}/${waba}/message_templates`, {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
        params: { name: tpl.name },
      })
    } catch (err) {
      const m = err.response?.data?.error?.message || err.message
      // If it's already gone from Meta, continue; otherwise report
      if (!/not found|does not exist/i.test(m)) {
        console.error('❌ Meta template delete failed:', m)
        return { error: `Could not delete from Meta: ${m}` }
      }
    }
  }

  // 4. Delete the local row
  await supabase.from('templates').delete().eq('id', templateId).eq('business_id', business.id)
  return { error: null }
}