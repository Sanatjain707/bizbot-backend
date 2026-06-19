import 'dotenv/config'
import axios from 'axios'
import { supabase } from '../config/database.js'

const GRAPH = 'https://graph.facebook.com/v19.0'

// Meta needs the WhatsApp Business Account ID (WABA), not the phone id.
// Store it per business as `waba_id`, fall back to an env default for single-tenant testing.
function wabaId(business) {
  return business?.waba_id || process.env.WHATSAPP_WABA_ID
}

// ── Create a template on Meta + save locally as PENDING ──
export async function createTemplate(business, { name, category, language, body, header, footer }) {
  // WhatsApp template names must be lowercase + underscores
  const safeName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60)

  const components = []
  if (header) components.push({ type: 'HEADER', format: 'TEXT', text: header })
  components.push({ type: 'BODY', text: body })
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
      // Extract body/header/footer from Meta's components array
      let body = '', header = '', footer = ''
      for (const c of (mt.components || [])) {
        if (c.type === 'BODY')   body   = c.text || ''
        if (c.type === 'HEADER' && c.format === 'TEXT') header = c.text || ''
        if (c.type === 'FOOTER') footer = c.text || ''
      }
      const status = (mt.status || 'PENDING').toUpperCase()

      if (byName.has(mt.name)) {
        // Update status (and refresh content) of an existing row
        await supabase.from('templates')
          .update({ status, meta_template_id: mt.id, body: body || undefined, header, footer })
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