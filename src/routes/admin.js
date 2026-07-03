// Operator console API. Cross-tenant reads/writes over all businesses.
// Mounted behind requireAdminAuth in index.js — every route assumes req.admin.

import { Router } from 'express'
import { supabase } from '../config/database.js'

export const adminRouter = Router()

const DAY = 86400000

// Monthly plan prices (INR). Trial = 0. Used for MRR on the overview.
const PLAN_PRICE = { starter: 999, growth: 1999, pro: 3999 }

// Write an audit row for a mutating action. Fire-and-forget: an audit hiccup
// shouldn't fail the operation, but we log it.
async function audit(req, action, targetBusinessId, detail = {}) {
  try {
    await supabase.from('admin_audit_log').insert({
      admin_email:        req.admin?.email || 'unknown',
      action,
      target_business_id: targetBusinessId || null,
      detail,
    })
  } catch (err) { console.error('audit log failed:', err.message) }
}

// Derive a lifecycle status from a business row — no query needed.
function clientStatus(b) {
  if (b.suspended) return 'suspended'
  const exp = b.plan_expires_at ? new Date(b.plan_expires_at) : null
  if (!exp || exp <= new Date()) return 'expired'
  return b.plan === 'trial' ? 'trial' : 'active'
}
function daysUntil(ts) {
  if (!ts) return null
  return Math.ceil((new Date(ts).getTime() - Date.now()) / DAY)
}

// ── Is-admin check (drives the frontend gate) ─────────
adminRouter.get('/me', (req, res) => {
  res.json({ admin: true, email: req.admin?.email || null })
})

// ── Platform overview ─────────────────────────────────
adminRouter.get('/overview', async (req, res) => {
  try {
    const { data: businesses } = await supabase.from('businesses')
      .select('id, name, type, plan, plan_expires_at, suspended, waba_status, created_at')
    const list = businesses || []

    const clients = { total: list.length, trial: 0, active: 0, expired: 0, suspended: 0 }
    for (const b of list) clients[clientStatus(b)]++

    // Trials/plans lapsing within 7 days (and not already expired/suspended).
    const expiringSoon = list
      .filter(b => !b.suspended && b.plan_expires_at)
      .map(b => ({ ...b, status: clientStatus(b), daysLeft: daysUntil(b.plan_expires_at) }))
      .filter(b => b.status !== 'expired' && b.daysLeft !== null && b.daysLeft <= 7)
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 20)
      .map(b => ({ id: b.id, name: b.name, plan: b.plan, status: b.status, daysLeft: b.daysLeft }))

    const recentSignups = [...list]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 10)
      .map(b => ({ id: b.id, name: b.name, type: b.type, plan: b.plan, status: clientStatus(b), created_at: b.created_at }))

    const [{ count: messages }, { count: appointments }, { count: customers }] = await Promise.all([
      supabase.from('messages').select('id', { count: 'exact', head: true }),
      supabase.from('appointments').select('id', { count: 'exact', head: true }),
      supabase.from('customers').select('id', { count: 'exact', head: true }),
    ])

    // MRR from currently-active paid clients (trial / expired / suspended excluded).
    const byPlan = { starter: 0, growth: 0, pro: 0 }
    let mrr = 0, payingClients = 0
    for (const b of list) {
      if (clientStatus(b) !== 'active') continue
      const price = PLAN_PRICE[b.plan]
      if (price) { byPlan[b.plan]++; mrr += price; payingClients++ }
    }

    res.json({
      clients,
      revenue: { mrr, payingClients, byPlan },
      expiringSoon,
      recentSignups,
      totals: { messages: messages || 0, appointments: appointments || 0, customers: customers || 0 },
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Client directory ──────────────────────────────────
// Keyset-paginated on (created_at, id) desc. Server-side search; the status
// filter is derived, so it's applied per page (a known MVP limitation — a page
// may return fewer than `limit` matches. Fine at current client counts).
// Returns { clients, nextCursor }.
adminRouter.get('/clients', async (req, res) => {
  try {
    const { search, status, cursor } = req.query
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))

    let q = supabase.from('businesses')
      .select('id, name, type, owner_name, email, plan, plan_expires_at, suspended, waba_status, whatsapp_phone_id, created_at')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    if (search) {
      const s = String(search).trim().replace(/[,()%_*"]/g, '').slice(0, 60)
      if (s) q = q.or(`name.ilike.%${s}%,email.ilike.%${s}%,owner_name.ilike.%${s}%`)
    }
    if (cursor) {
      const { data: anchor } = await supabase.from('businesses').select('created_at, id').eq('id', cursor).single()
      if (anchor) q = q.or(`created_at.lt.${anchor.created_at},and(created_at.eq.${anchor.created_at},id.lt.${anchor.id})`)
    }

    const { data } = await q
    let rows = (data || []).map(b => ({
      id: b.id, name: b.name, type: b.type, owner_name: b.owner_name, email: b.email,
      plan: b.plan, plan_expires_at: b.plan_expires_at, waba_status: b.waba_status,
      whatsapp_phone_id: b.whatsapp_phone_id, created_at: b.created_at,
      status: clientStatus(b), daysLeft: daysUntil(b.plan_expires_at),
    }))
    if (status && status !== 'all') rows = rows.filter(r => r.status === status)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    // Batched last-activity lookup for the page (one query, not N per client).
    const ids = page.map(r => r.id)
    const lastByBiz = new Map()
    if (ids.length) {
      const { data: recent } = await supabase.from('messages')
        .select('business_id, created_at').in('business_id', ids)
        .order('created_at', { ascending: false }).limit(ids.length * 4)
      for (const m of recent || []) if (!lastByBiz.has(m.business_id)) lastByBiz.set(m.business_id, m.created_at)
    }
    for (const r of page) {
      const last = lastByBiz.get(r.id) || null
      const inactiveDays = last ? Math.floor((Date.now() - new Date(last).getTime()) / DAY) : null
      const signupAge = r.created_at ? Math.floor((Date.now() - new Date(r.created_at).getTime()) / DAY) : 0
      r.lastActivity = last
      r.inactiveDays = inactiveDays
      // At-risk = churn signals only (WABA-pending is shown separately as its
      // own state, not churn). Expired, trial about to lapse, gone quiet, or
      // signed up a week ago and never sent a message.
      r.atRisk = r.status === 'expired'
        || (r.status === 'trial' && r.daysLeft !== null && r.daysLeft <= 5)
        || (inactiveDays !== null && inactiveDays >= 14)
        || (inactiveDays === null && signupAge >= 7)
    }
    res.json({ clients: page, nextCursor: hasMore ? page[page.length - 1].id : null })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Client detail (full profile + usage aggregates) ───
adminRouter.get('/clients/:id', async (req, res) => {
  try {
    const { data: b } = await supabase.from('businesses').select('*').eq('id', req.params.id).single()
    if (!b) return res.status(404).json({ error: 'Client not found' })
    const id = b.id

    const [msgs, aiMsgs, appts, custs, alerts, paid, lastMsg] = await Promise.all([
      supabase.from('messages').select('id', { count: 'exact', head: true }).eq('business_id', id),
      supabase.from('messages').select('id', { count: 'exact', head: true }).eq('business_id', id).eq('role', 'assistant'),
      supabase.from('appointments').select('id', { count: 'exact', head: true }).eq('business_id', id),
      supabase.from('customers').select('id', { count: 'exact', head: true }).eq('business_id', id),
      supabase.from('booking_alerts').select('id', { count: 'exact', head: true }).eq('business_id', id).eq('status', 'open'),
      supabase.from('payments').select('amount').eq('business_id', id).eq('status', 'paid'),
      supabase.from('messages').select('created_at').eq('business_id', id).order('created_at', { ascending: false }).limit(1),
    ])
    const revenueCollected = (paid.data || []).reduce((s, p) => s + Number(p.amount || 0), 0)

    res.json({
      client: { ...b, status: clientStatus(b), daysLeft: daysUntil(b.plan_expires_at) },
      usage: {
        messages:     msgs.count || 0,
        aiReplies:    aiMsgs.count || 0,
        appointments: appts.count || 0,
        customers:    custs.count || 0,
        openAlerts:   alerts.count || 0,
        revenueCollected,
        lastActivity: lastMsg.data?.[0]?.created_at || null,
      },
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Change plan / extend trial ────────────────────────
adminRouter.patch('/clients/:id/plan', async (req, res) => {
  try {
    const { plan, extendDays, plan_expires_at } = req.body
    const update = {}
    if (plan) update.plan = String(plan)
    if (plan_expires_at) update.plan_expires_at = new Date(plan_expires_at).toISOString()
    if (extendDays) {
      // Extend from the later of now or the current (still-valid) expiry.
      const { data: cur } = await supabase.from('businesses').select('plan_expires_at').eq('id', req.params.id).single()
      const base = cur?.plan_expires_at && new Date(cur.plan_expires_at) > new Date() ? new Date(cur.plan_expires_at) : new Date()
      base.setDate(base.getDate() + Number(extendDays))
      update.plan_expires_at = base.toISOString()
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'Provide plan, extendDays, or plan_expires_at' })
    }
    const { data, error } = await supabase.from('businesses').update(update).eq('id', req.params.id).select().single()
    if (error) return res.status(400).json({ error: error.message })
    await audit(req, 'plan_change', req.params.id, update)
    res.json({ success: true, client: data })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Suspend / reactivate, or flip WABA status ─────────
adminRouter.patch('/clients/:id/status', async (req, res) => {
  try {
    const update = {}
    if (typeof req.body.suspended === 'boolean') update.suspended = req.body.suspended
    if (req.body.waba_status && ['pending', 'live'].includes(req.body.waba_status)) update.waba_status = req.body.waba_status
    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'Provide suspended (boolean) or waba_status (pending|live)' })
    }
    const { data, error } = await supabase.from('businesses').update(update).eq('id', req.params.id).select().single()
    if (error) return res.status(400).json({ error: error.message })
    await audit(req, 'status_change', req.params.id, update)
    res.json({ success: true, client: data })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Cross-tenant booking alerts ───────────────────────
// Every "AI couldn't book" event across ALL clients, so the operator can spot
// systemic AI-quality issues. Read-only here (the client owner resolves their
// own alerts in their dashboard). Keyset-paginated. Returns { alerts, nextCursor }.
adminRouter.get('/alerts', async (req, res) => {
  try {
    const { status, cursor } = req.query
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
    let q = supabase.from('booking_alerts')
      .select('*, businesses(name), customers(name, phone)')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)
    if (status && status !== 'all') q = q.eq('status', status)
    if (cursor) {
      const { data: anchor } = await supabase.from('booking_alerts').select('created_at, id').eq('id', cursor).single()
      if (anchor) q = q.or(`created_at.lt.${anchor.created_at},and(created_at.eq.${anchor.created_at},id.lt.${anchor.id})`)
    }
    const { data } = await q
    const rows = data || []
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    res.json({ alerts: page, nextCursor: hasMore ? page[page.length - 1].id : null })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Audit log ─────────────────────────────────────────
adminRouter.get('/audit', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100))
    const { cursor } = req.query
    let q = supabase.from('admin_audit_log')
      .select('*, businesses(name)')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)
    if (cursor) {
      const { data: anchor } = await supabase.from('admin_audit_log').select('created_at, id').eq('id', cursor).single()
      if (anchor) q = q.or(`created_at.lt.${anchor.created_at},and(created_at.eq.${anchor.created_at},id.lt.${anchor.id})`)
    }
    const { data } = await q
    const rows = data || []
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    res.json({ entries: page, nextCursor: hasMore ? page[page.length - 1].id : null })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Support notes (internal, per client) ──────────────
adminRouter.get('/clients/:id/notes', async (req, res) => {
  try {
    const { data } = await supabase.from('support_notes')
      .select('*').eq('business_id', req.params.id)
      .order('created_at', { ascending: false }).limit(100)
    res.json({ notes: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})
adminRouter.post('/clients/:id/notes', async (req, res) => {
  try {
    const body = String(req.body?.body || '').trim()
    if (!body) return res.status(400).json({ error: 'Note body required' })
    const { data, error } = await supabase.from('support_notes')
      .insert({ business_id: req.params.id, author: req.admin?.email || 'unknown', body })
      .select().single()
    if (error) return res.status(400).json({ error: error.message })
    res.status(201).json(data)
  } catch (err) { res.status(500).json({ error: err.message }) }
})
adminRouter.delete('/notes/:noteId', async (req, res) => {
  try {
    const { error } = await supabase.from('support_notes').delete().eq('id', req.params.noteId)
    if (error) return res.status(400).json({ error: error.message })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Delete a client and ALL associated data (irreversible) ──
// customers/messages/appointments/payments/support_notes cascade from the
// businesses row. We explicitly clear tables that may NOT cascade first
// (booking_alerts, broadcast tables), then delete the business. Audit-logged.
adminRouter.delete('/clients/:id', async (req, res) => {
  const id = req.params.id
  try {
    const { data: biz } = await supabase.from('businesses').select('id, name').eq('id', id).single()
    if (!biz) return res.status(404).json({ error: 'Client not found' })

    const cnt = async (t) => (await supabase.from(t).select('id', { count: 'exact', head: true }).eq('business_id', id)).count || 0
    const deleted = {
      customers:    await cnt('customers'),
      messages:     await cnt('messages'),
      appointments: await cnt('appointments'),
      payments:     await cnt('payments'),
    }

    // Best-effort clear of tables that may lack ON DELETE CASCADE (or not exist
    // on every deployment). Failures here are non-fatal.
    const safeDel = async (fn) => { try { await fn() } catch (_) {} }
    await safeDel(() => supabase.from('booking_alerts').delete().eq('business_id', id))
    await safeDel(() => supabase.from('support_notes').delete().eq('business_id', id))
    await safeDel(async () => {
      const { data: camps } = await supabase.from('campaigns').select('id').eq('business_id', id)
      const ids = (camps || []).map(c => c.id)
      if (ids.length) await supabase.from('campaign_recipients').delete().in('campaign_id', ids)
      await supabase.from('campaigns').delete().eq('business_id', id)
    })
    await safeDel(() => supabase.from('templates').delete().eq('business_id', id))

    // Delete the business — cascades customers → messages/appointments/payments.
    const { error } = await supabase.from('businesses').delete().eq('id', id)
    if (error) return res.status(400).json({ error: error.message })

    // target_business_id must be null (the row is gone) — keep the id in detail.
    await audit(req, 'client_deleted', null, { business_id: id, name: biz.name, deleted })
    res.json({ success: true, deleted })
  } catch (err) { res.status(500).json({ error: err.message }) }
})
