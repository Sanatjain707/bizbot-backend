import { Router } from 'express'
import { supabase } from '../config/database.js'

export const analyticsRouter = Router()
const bid = req => req.headers['x-business-id']

// ── IST helpers ───────────────────────────────────────
// This is an Indian product: a "day" means IST (UTC+5:30) midnight, not UTC.
// We shift instants by +5:30 and read UTC parts to get IST wall-clock values.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const istShift = d => new Date(new Date(d).getTime() + IST_OFFSET_MS)
const istDate    = d => istShift(d).toISOString().slice(0, 10)   // 'YYYY-MM-DD' in IST
const istHour    = d => istShift(d).getUTCHours()                // 0-23 in IST
const istWeekday = d => istShift(d).getUTCDay()                  // 0=Sun..6=Sat in IST
// UTC instant for IST-midnight of a 'YYYY-MM-DD'
const istMidnightUtc = dateStr => new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - IST_OFFSET_MS)
const addDays = (dateStr, n) => new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10)

// Page past Supabase's 1000-row cap so KPIs never silently undercount.
async function fetchAll(buildQuery) {
  const out = []; const size = 1000; let start = 0
  for (;;) {
    const { data, error } = await buildQuery().range(start, start + size - 1)
    if (error) throw new Error(error.message)
    if (!data?.length) break
    out.push(...data)
    if (data.length < size) break
    start += size
  }
  return out
}

function resolveRange(q) {
  const todayIst = istDate(Date.now())
  let fromStr, toStr, isPreset = false
  if (q.from && q.to) { fromStr = q.from; toStr = q.to }
  else {
    const preset = [7, 30, 90].includes(Number(q.preset)) ? Number(q.preset) : 30
    toStr = todayIst
    fromStr = addDays(todayIst, -(preset - 1))
    isPreset = true
  }
  const startUtc = istMidnightUtc(fromStr)
  const endUtc   = istMidnightUtc(addDays(toStr, 1))   // exclusive: start of the day after `to`
  const days = Math.round((endUtc - startUtc) / DAY_MS)
  return {
    fromStr, toStr, days, startUtc, endUtc,
    prevStartUtc: new Date(startUtc.getTime() - days * DAY_MS),
    prevEndUtc: startUtc,
    label: isPreset ? `${days} days` : `${fromStr} → ${toStr}`,
  }
}

const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0)
const pct = (value, prev) => (!prev || prev <= 0) ? null : Math.round(((value - prev) / prev) * 100)

// Core computation shared by the JSON endpoint and the CSV export.
export async function computeAnalytics(businessId, query) {
  const R = resolveRange(query)
  const startISO = R.startUtc.toISOString(), endISO = R.endUtc.toISOString()
  const pStartISO = R.prevStartUtc.toISOString(), pEndISO = R.prevEndUtc.toISOString()

  // reengagement_sent may not exist on every deployment — never let it 500 the endpoint.
  const safeReengaged = fetchAll(() =>
    supabase.from('customers').select('id, last_seen').eq('business_id', businessId).eq('reengagement_sent', true)
  ).catch(() => [])

  const [
    messages, appts, paidPayments, newCustomers, pendingRows, priorApptRows, reengaged,
    baseline, prevMessages, prevApptCount, prevPaid, prevNewCount,
  ] = await Promise.all([
    fetchAll(() => supabase.from('messages').select('customer_id, role, created_at').eq('business_id', businessId).gte('created_at', startISO).lt('created_at', endISO)),
    fetchAll(() => supabase.from('appointments').select('customer_id, service, appointment_time, status').eq('business_id', businessId).gte('appointment_time', startISO).lt('appointment_time', endISO)),
    fetchAll(() => supabase.from('payments').select('customer_id, amount, paid_at').eq('business_id', businessId).eq('status', 'paid').gte('paid_at', startISO).lt('paid_at', endISO)),
    fetchAll(() => supabase.from('customers').select('id, created_at').eq('business_id', businessId).gte('created_at', startISO).lt('created_at', endISO)),
    fetchAll(() => supabase.from('payments').select('amount').eq('business_id', businessId).eq('status', 'pending')),
    fetchAll(() => supabase.from('appointments').select('customer_id').eq('business_id', businessId).lt('appointment_time', startISO)),
    safeReengaged,
    supabase.from('customers').select('id', { count: 'exact', head: true }).eq('business_id', businessId).lt('created_at', startISO),
    fetchAll(() => supabase.from('messages').select('customer_id, role').eq('business_id', businessId).gte('created_at', pStartISO).lt('created_at', pEndISO)),
    supabase.from('appointments').select('id', { count: 'exact', head: true }).eq('business_id', businessId).gte('appointment_time', pStartISO).lt('appointment_time', pEndISO),
    fetchAll(() => supabase.from('payments').select('amount').eq('business_id', businessId).eq('status', 'paid').gte('paid_at', pStartISO).lt('paid_at', pEndISO)),
    supabase.from('customers').select('id', { count: 'exact', head: true }).eq('business_id', businessId).gte('created_at', pStartISO).lt('created_at', pEndISO),
  ])

  // ── KPIs ──
  const customersEngaged = new Set(messages.map(m => m.customer_id)).size
  const aiMessages       = messages.filter(m => m.role === 'assistant').length
  const revenueCollected = sum(paidPayments, 'amount')
  const revenuePending   = sum(pendingRows, 'amount')
  const prevEngaged      = new Set(prevMessages.map(m => m.customer_id)).size
  const prevAi           = prevMessages.filter(m => m.role === 'assistant').length
  const prevRevenue      = sum(prevPaid, 'amount')

  const kpis = {
    customersEngaged: { value: customersEngaged, prev: prevEngaged, changePct: pct(customersEngaged, prevEngaged) },
    appointments:     { value: appts.length, prev: prevApptCount.count || 0, changePct: pct(appts.length, prevApptCount.count || 0) },
    revenueCollected: { value: revenueCollected, prev: prevRevenue, changePct: pct(revenueCollected, prevRevenue) },
    revenuePending:   { value: revenuePending },
    newCustomers:     { value: newCustomers.length, prev: prevNewCount.count || 0, changePct: pct(newCustomers.length, prevNewCount.count || 0) },
    aiMessages:       { value: aiMessages, prev: prevAi, changePct: pct(aiMessages, prevAi) },
  }

  // ── Day axis (IST calendar days, inclusive) ──
  const dayKeys = []
  for (let d = R.fromStr; d <= R.toStr; d = addDays(d, 1)) dayKeys.push(d)

  // Engagement over time: distinct customers + message count per IST day
  const perDayCustomers = Object.fromEntries(dayKeys.map(d => [d, new Set()]))
  const perDayMessages  = Object.fromEntries(dayKeys.map(d => [d, 0]))
  for (const m of messages) {
    const d = istDate(m.created_at)
    if (perDayCustomers[d]) { perDayCustomers[d].add(m.customer_id); perDayMessages[d]++ }
  }
  const engagementOverTime = dayKeys.map(d => ({ date: d, customers: perDayCustomers[d].size, messages: perDayMessages[d] }))

  // Appointments by status
  const statusMap = { confirmed: 'Booked', done: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' }
  const statusCounts = { Booked: 0, Completed: 0, Cancelled: 0, 'No-show': 0 }
  for (const a of appts) { const label = statusMap[a.status]; if (label) statusCounts[label]++ }
  const appointmentsByStatus = Object.entries(statusCounts).map(([status, value]) => ({ status, value }))

  // Revenue trend — day buckets for short ranges, else 7-day buckets
  const unit = R.days <= 31 ? 'day' : 'week'
  const revenueBuckets = {}
  for (const p of paidPayments) {
    const dISO = istDate(p.paid_at)
    let bucket = dISO
    if (unit === 'week') {
      const idx = Math.floor((istMidnightUtc(dISO) - R.startUtc) / DAY_MS / 7)
      bucket = addDays(R.fromStr, idx * 7)
    }
    revenueBuckets[bucket] = (revenueBuckets[bucket] || 0) + Number(p.amount || 0)
  }
  const revenueTrend = (unit === 'day' ? dayKeys : dayKeys.filter((_, i) => i % 7 === 0))
    .map(b => ({ bucket: b, revenue: revenueBuckets[b] || 0 }))

  // Customer growth — cumulative from a pre-range baseline
  const perDayNew = Object.fromEntries(dayKeys.map(d => [d, 0]))
  for (const c of newCustomers) { const d = istDate(c.created_at); if (perDayNew[d] !== undefined) perDayNew[d]++ }
  let running = baseline.count || 0
  const customerGrowth = dayKeys.map(d => { running += perDayNew[d]; return { date: d, total: running } })

  // Busiest weekdays (Mon→Sun) & hours (IST)
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const wdCounts = [0, 0, 0, 0, 0, 0, 0], hourCounts = Array(24).fill(0)
  for (const a of appts) { wdCounts[istWeekday(a.appointment_time)]++; hourCounts[istHour(a.appointment_time)]++ }
  const busiestWeekdays = [1, 2, 3, 4, 5, 6, 0].map(i => ({ day: WD[i], value: wdCounts[i] }))
  const busiestHours = hourCounts.map((value, hour) => ({ hour, value }))

  // Top services
  const svcCounts = {}
  for (const a of appts) { const s = (a.service || '').trim(); if (s) svcCounts[s] = (svcCounts[s] || 0) + 1 }
  const topServices = Object.entries(svcCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([service, value]) => ({ service, value }))

  // ── Insights ──
  const priorSet = new Set(priorApptRows.map(r => r.customer_id))
  const activeSet = new Set(appts.map(a => a.customer_id))
  let repeat = 0, fresh = 0
  for (const id of activeSet) (priorSet.has(id) ? repeat++ : fresh++)
  const activeTotal = activeSet.size

  // No-show rate is measured only over appointments with a recorded outcome
  // (completed or no-show) — NOT all bookings — so "concluded" is surfaced as
  // the explicit denominator to avoid it reading as "% of all customers".
  const noShow = statusCounts['No-show'], completed = statusCounts.Completed
  const concluded = noShow + completed

  const payingCustomers = new Set(paidPayments.map(p => p.customer_id)).size

  const reReturned = reengaged.filter(c => {
    if (!c.last_seen) return false
    const t = new Date(c.last_seen)
    return t >= R.startUtc && t < R.endUtc
  }).length

  const insights = {
    repeatVsNew: { new: fresh, repeat, repeatPct: activeTotal > 0 ? Math.round((repeat / activeTotal) * 100) : 0 },
    noShowRate:  { pct: concluded > 0 ? Math.round((noShow / concluded) * 100) : 0, noShow, concluded },
    avgRevenuePerCustomer: payingCustomers > 0 ? Math.round(revenueCollected / payingCustomers) : 0,
    reengagement: { reEngaged: reengaged.length, returned: reReturned, pct: reengaged.length > 0 ? Math.round((reReturned / reengaged.length) * 100) : 0, estimate: true },
  }

  const hasData = (messages.length + appts.length + paidPayments.length + newCustomers.length) > 0

  return {
    range: { from: R.fromStr, to: R.toStr, days: R.days, label: R.label },
    hasData,
    kpis,
    charts: { engagementOverTime, appointmentsByStatus, revenueTrend, revenueTrendUnit: unit, customerGrowth, busiestWeekdays, busiestHours, topServices },
    insights,
  }
}

analyticsRouter.get('/', async (req, res) => {
  const businessId = bid(req)
  if (!businessId) return res.status(400).json({ error: 'x-business-id required' })
  try {
    res.json(await computeAnalytics(businessId, req.query))
  } catch (err) {
    console.error('❌ Analytics error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── CSV export: KPI summary + underlying rows for the range ──
const csvCell = v => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvRow = arr => arr.map(csvCell).join(',')

analyticsRouter.get('/export', async (req, res) => {
  const businessId = bid(req)
  if (!businessId) return res.status(400).json({ error: 'x-business-id required' })
  try {
    const a = await computeAnalytics(businessId, req.query)
    const R = resolveRange(req.query)
    const startISO = R.startUtc.toISOString(), endISO = R.endUtc.toISOString()

    const [apptRows, payRows] = await Promise.all([
      fetchAll(() => supabase.from('appointments').select('appointment_time, service, status, customers(name, phone)').eq('business_id', businessId).gte('appointment_time', startISO).lt('appointment_time', endISO).order('appointment_time')),
      fetchAll(() => supabase.from('payments').select('paid_at, amount, description, customers(name, phone)').eq('business_id', businessId).eq('status', 'paid').gte('paid_at', startISO).lt('paid_at', endISO).order('paid_at')),
    ])

    const lines = []
    lines.push(csvRow(['BizBot Analytics Export']))
    lines.push(csvRow(['Range', `${a.range.from} to ${a.range.to}`]))
    lines.push('')
    lines.push(csvRow(['KPIs']))
    lines.push(csvRow(['Metric', 'Value', 'Previous', 'Change %']))
    lines.push(csvRow(['Customers engaged', a.kpis.customersEngaged.value, a.kpis.customersEngaged.prev, a.kpis.customersEngaged.changePct ?? 'new']))
    lines.push(csvRow(['Appointments', a.kpis.appointments.value, a.kpis.appointments.prev, a.kpis.appointments.changePct ?? 'new']))
    lines.push(csvRow(['Revenue collected', a.kpis.revenueCollected.value, a.kpis.revenueCollected.prev, a.kpis.revenueCollected.changePct ?? 'new']))
    lines.push(csvRow(['Revenue pending', a.kpis.revenuePending.value, '', '']))
    lines.push(csvRow(['New customers', a.kpis.newCustomers.value, a.kpis.newCustomers.prev, a.kpis.newCustomers.changePct ?? 'new']))
    lines.push(csvRow(['AI messages', a.kpis.aiMessages.value, a.kpis.aiMessages.prev, a.kpis.aiMessages.changePct ?? 'new']))
    lines.push('')
    lines.push(csvRow([`Appointments (${a.range.from} to ${a.range.to})`]))
    lines.push(csvRow(['Date (IST)', 'Time (IST)', 'Customer', 'Phone', 'Service', 'Status']))
    for (const r of apptRows) {
      const ist = istShift(r.appointment_time)
      lines.push(csvRow([ist.toISOString().slice(0, 10), ist.toISOString().slice(11, 16), r.customers?.name || '', r.customers?.phone || '', r.service || '', r.status || '']))
    }
    lines.push('')
    lines.push(csvRow([`Payments collected (${a.range.from} to ${a.range.to})`]))
    lines.push(csvRow(['Date (IST)', 'Customer', 'Phone', 'Amount', 'Description']))
    for (const r of payRows) {
      lines.push(csvRow([istDate(r.paid_at), r.customers?.name || '', r.customers?.phone || '', r.amount, r.description || '']))
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="bizbot-analytics-${a.range.from}-to-${a.range.to}.csv"`)
    res.send(lines.join('\n'))
  } catch (err) {
    console.error('❌ Analytics export error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
