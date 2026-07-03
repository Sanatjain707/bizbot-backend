// Operator console API. Cross-tenant reads/writes over all businesses.
// Mounted behind requireAdminAuth in index.js — every route assumes req.admin.

import { Router } from 'express'
import { supabase } from '../config/database.js'

export const adminRouter = Router()

const DAY = 86400000

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

    res.json({
      clients,
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
    let rows = (data || []).map(b => {
      const st = clientStatus(b)
      const daysLeft = daysUntil(b.plan_expires_at)
      return {
        id: b.id, name: b.name, type: b.type, owner_name: b.owner_name, email: b.email,
        plan: b.plan, plan_expires_at: b.plan_expires_at, waba_status: b.waba_status,
        whatsapp_phone_id: b.whatsapp_phone_id, created_at: b.created_at,
        status: st, daysLeft,
        // Cheap at-risk heuristic; activity-based signal lands in Phase 2.
        atRisk: st === 'expired' || (st === 'trial' && daysLeft !== null && daysLeft <= 5) || b.waba_status !== 'live',
      }
    })
    if (status && status !== 'all') rows = rows.filter(r => r.status === status)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
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
