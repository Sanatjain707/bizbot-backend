import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { istDateStr, istMidnightUtc, istEndOfDayUtc } from '../utils/dateTime.js'

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env')
}

export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

// ── Phone normalization ───────────────────────────────
// WhatsApp sends "918505830571". Manual entry might be "8505830571" or "+91 8505830571".
// Normalize everything to the WhatsApp format: country code + number, digits only.
export function normalizePhone(raw) {
  if (!raw) return raw
  let p = String(raw).replace(/\D/g, '') // strip everything except digits
  // If it's a 10-digit Indian number, prepend 91
  if (p.length === 10) p = '91' + p
  // If it starts with 0 then 10 digits (0XXXXXXXXXX), drop 0 and add 91
  else if (p.length === 11 && p.startsWith('0')) p = '91' + p.slice(1)
  return p
}

// ── Business ──────────────────────────────────────────
export async function getBusinessByPhoneId(phoneId) {
  const { data } = await supabase.from('businesses').select('*').eq('whatsapp_phone_id', phoneId).single()
  return data
}
export async function getBusinessById(id) {
  const { data } = await supabase.from('businesses').select('*').eq('id', id).single()
  return data
}
export async function updateBusiness(id, fields) {
  const { data, error } = await supabase.from('businesses').update(fields).eq('id', id).select().single()
  return { data, error }
}
export async function createBusiness(fields) {
  const { data, error } = await supabase.from('businesses').insert(fields).select().single()
  return { data, error }
}

// ── Customers ─────────────────────────────────────────
export async function getOrCreateCustomer(businessId, phone, name = null) {
  const normPhone = normalizePhone(phone)
  const now = new Date().toISOString()

  const { data: existing } = await supabase.from('customers').select('*')
    .eq('business_id', businessId).eq('phone', normPhone).maybeSingle()
  if (existing) {
    const update = { last_seen: now }
    if (name && !existing.name) update.name = name
    await supabase.from('customers').update(update).eq('id', existing.id)
    return existing
  }
  // Race-safe insert: unique(business_id, phone) means a concurrent webhook
  // for the same phone can beat us to the INSERT. Use upsert so both callers
  // succeed and get the same row back.
  const { data: upserted, error } = await supabase.from('customers')
    .upsert({ business_id: businessId, phone: normPhone, name, last_seen: now },
             { onConflict: 'business_id,phone' })
    .select().single()
  if (error) {
    // Fallback: another writer just created the row → re-SELECT.
    const { data: raced } = await supabase.from('customers').select('*')
      .eq('business_id', businessId).eq('phone', normPhone).maybeSingle()
    return raced
  }
  return upserted
}
export async function updateCustomerName(id, name) {
  await supabase.from('customers').update({ name }).eq('id', id)
}
export async function getAllCustomers(businessId, { limit = 500 } = {}) {
  // Hard cap so the endpoint stays responsive as data grows. For fuller
  // lists callers should paginate (add a cursor helper if you need it).
  const capped = Math.max(1, Math.min(2000, Number(limit) || 500))
  const { data } = await supabase.from('customers').select('*')
    .eq('business_id', businessId)
    .order('last_seen', { ascending: false })
    .limit(capped)
  return data || []
}
export async function getCustomerAIEnabled(customerId) {
  const { data } = await supabase.from('customers').select('ai_enabled').eq('id', customerId).single()
  return data?.ai_enabled !== false  // default true
}
export async function setCustomerAIEnabled(customerId, enabled) {
  await supabase.from('customers').update({ ai_enabled: enabled }).eq('id', customerId)
}

// ── Messages ──────────────────────────────────────────
export async function saveMessage(businessId, customerId, role, content) {
  await supabase.from('messages').insert({ business_id: businessId, customer_id: customerId, role, content, created_at: new Date().toISOString() })
}
export async function getHistory(customerId, limit = 12) {
  const { data } = await supabase.from('messages').select('role, content').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(limit)
  return (data || []).reverse()
}
// ── Windowed history: recent verbatim + earlier turns to summarize ──
// aiService uses this to keep the last N messages full-fidelity and roll
// everything older into a cheap concat summary (fewer tokens per turn).
export async function getHistoryWindow(customerId, recent = 6, lookback = 40) {
  const { data } = await supabase.from('messages')
    .select('role, content')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(lookback)
  const chrono = (data || []).reverse()
  if (chrono.length <= recent) return { recent: chrono, older: [] }
  return {
    recent: chrono.slice(-recent),
    older:  chrono.slice(0, -recent),
  }
}
export async function getConversations(businessId, { cursor = null, limit = 50, search = null } = {}) {
  const capped = Math.max(1, Math.min(200, Number(limit) || 50))
  let query = supabase.from('customers')
    .select('id, name, phone, last_seen, ai_enabled')
    .eq('business_id', businessId)
    .order('last_seen', { ascending: false })
    .order('id', { ascending: false })
    .limit(capped + 1)
  if (search) {
    // PostgREST .or() treats , ( ) as delimiters and % _ as wildcards. Strip
    // them from the caller-supplied string so the search input can't inject
    // extra conditions or wildcard-match everything.
    const s = String(search).trim().replace(/[,()%_*"]/g, '').slice(0, 60)
    if (s) query = query.or(`name.ilike.%${s}%,phone.ilike.%${s}%`)
  }
  if (cursor) {
    const { data: anchor } = await supabase.from('customers').select('last_seen, id').eq('id', cursor).single()
    if (anchor) {
      query = query.or(`last_seen.lt.${anchor.last_seen},and(last_seen.eq.${anchor.last_seen},id.lt.${anchor.id})`)
    }
  }
  const { data: customers } = await query
  const rows = customers || []
  const hasMore = rows.length > capped
  const page = hasMore ? rows.slice(0, capped) : rows

  // ── Batch last-message lookup (was N+1: one query per customer) ──
  // Pull the most recent ~N*4 messages across the whole page in a single
  // query, then pick the newest per customer in JS. The 4× multiplier is a
  // safety margin so a chatty customer doesn't crowd out someone quieter.
  const customerIds = page.map(c => c.id)
  const lastByCustomer = new Map()
  if (customerIds.length) {
    const { data: recent } = await supabase.from('messages')
      .select('customer_id, role, content, created_at')
      .in('customer_id', customerIds)
      .order('created_at', { ascending: false })
      .limit(customerIds.length * 4)
    for (const m of recent || []) {
      if (!lastByCustomer.has(m.customer_id)) lastByCustomer.set(m.customer_id, m)
    }
    // Anyone missed by the safety window (very rare) gets one small fallback query.
    const missing = customerIds.filter(id => !lastByCustomer.has(id))
    for (const id of missing) {
      const { data: msgs } = await supabase.from('messages')
        .select('role, content, created_at')
        .eq('customer_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
      if (msgs?.[0]) lastByCustomer.set(id, msgs[0])
    }
  }

  const result = page.map(c => {
    const last = lastByCustomer.get(c.id)
    return {
      id: c.id, phone: c.phone, name: c.name,
      ai_enabled: c.ai_enabled !== false,
      last_msg:  last?.content?.slice(0, 60) || '',
      last_time: timeAgo(c.last_seen),
      unread:    last?.role === 'user' ? 1 : 0,
    }
  })
  return { conversations: result, nextCursor: hasMore ? page[page.length - 1].id : null }
}
export async function getMessages(customerId, { limit = 500 } = {}) {
  // Cap the legacy full-thread read. Long conversations should use
  // getMessagesPage instead — this endpoint stays as an escape hatch.
  const capped = Math.max(1, Math.min(2000, Number(limit) || 500))
  const { data } = await supabase.from('messages').select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true })
    .limit(capped)
  return data || []
}
// ── Cursor-paginated messages ─────────────────────────
// Newest-first, keyset paginated. `cursor` is the `id` of the last row from
// the previous page; caller passes it back to get the next slice. Returns
// { messages, nextCursor: null | 'uuid' }.
export async function getMessagesPage(customerId, { cursor = null, limit = 50 } = {}) {
  const capped = Math.max(1, Math.min(200, Number(limit) || 50))
  let query = supabase.from('messages')
    .select('id, role, content, created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(capped + 1)
  if (cursor) {
    // Fetch the cursor row's timestamp so we can seek past it.
    const { data: anchor } = await supabase.from('messages').select('created_at, id').eq('id', cursor).single()
    if (anchor) {
      query = query.or(`created_at.lt.${anchor.created_at},and(created_at.eq.${anchor.created_at},id.lt.${anchor.id})`)
    }
  }
  const { data } = await query
  const rows = data || []
  const hasMore = rows.length > capped
  const page = hasMore ? rows.slice(0, capped) : rows
  return { messages: page, nextCursor: hasMore ? page[page.length - 1].id : null }
}

// ── Appointments ──────────────────────────────────────
export async function createAppointment(data) {
  const { data: appt } = await supabase.from('appointments').insert(data).select().single()
  return appt
}
// Find the customer's next upcoming confirmed appointment (for reschedule/cancel)
export async function getUpcomingAppointmentForCustomer(customerId) {
  const { data } = await supabase.from('appointments')
    .select('*')
    .eq('customer_id', customerId)
    .eq('status', 'confirmed')
    .gte('appointment_time', new Date().toISOString())
    .order('appointment_time', { ascending: true })
    .limit(1)
  return data?.[0] || null
}
export async function rescheduleAppointment(id, newTime) {
  const { data } = await supabase.from('appointments')
    .update({ appointment_time: newTime, reminder_sent: false })
    .eq('id', id).select().single()
  return data
}
export async function cancelAppointment(id) {
  await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', id)
}
export async function getTodayAppointments(businessId) {
  const today = istDateStr()
  const { data } = await supabase.from('appointments')
    .select('*, customers(name, phone)')
    .eq('business_id', businessId)
    .gte('appointment_time', istMidnightUtc(today))
    .lte('appointment_time', istEndOfDayUtc(today))
    .order('appointment_time')
  return data || []
}
export async function getAllAppointments(businessId, { limit = 500 } = {}) {
  const capped = Math.max(1, Math.min(2000, Number(limit) || 500))
  const { data } = await supabase.from('appointments').select('*, customers(name, phone)')
    .eq('business_id', businessId)
    .order('appointment_time', { ascending: false })
    .limit(capped)
  return data || []
}
// ── Cursor-paginated appointments with filters ────────
// filters: { status, from, to, customerId, service }
export async function getAppointmentsPage(businessId, { cursor = null, limit = 50, filters = {} } = {}) {
  const capped = Math.max(1, Math.min(200, Number(limit) || 50))
  let query = supabase.from('appointments')
    .select('*, customers(name, phone)')
    .eq('business_id', businessId)
    .order('appointment_time', { ascending: false })
    .order('id', { ascending: false })
    .limit(capped + 1)
  if (filters.status)     query = query.eq('status', filters.status)
  if (filters.customerId) query = query.eq('customer_id', filters.customerId)
  if (filters.service)    query = query.eq('service', filters.service)
  if (filters.from)       query = query.gte('appointment_time', filters.from)
  if (filters.to)         query = query.lte('appointment_time', filters.to)
  if (cursor) {
    const { data: anchor } = await supabase.from('appointments').select('appointment_time, id').eq('id', cursor).single()
    if (anchor) {
      query = query.or(`appointment_time.lt.${anchor.appointment_time},and(appointment_time.eq.${anchor.appointment_time},id.lt.${anchor.id})`)
    }
  }
  const { data } = await query
  const rows = data || []
  const hasMore = rows.length > capped
  const page = hasMore ? rows.slice(0, capped) : rows
  return { appointments: page, nextCursor: hasMore ? page[page.length - 1].id : null }
}
export async function updateAppointmentStatus(id, status, businessId = null) {
  // Scope by business when the caller knows their id — prevents cross-tenant
  // mutation via a guessed appointment UUID.
  let q = supabase.from('appointments').update({ status }).eq('id', id)
  if (businessId) q = q.eq('business_id', businessId)
  const { error, count } = await q.select('id', { count: 'exact' })
  if (!error && count === 0) return { error: { message: 'Not found or not owned by this business' } }
  return { error }
}
export async function getUpcomingForReminder(hoursAhead = 24) {
  const now = new Date(), future = new Date(now.getTime() + hoursAhead * 3600000)
  const { data } = await supabase.from('appointments').select('*, customers(name, phone), businesses(name, whatsapp_phone_id)').eq('status', 'confirmed').eq('reminder_sent', false).gte('appointment_time', now.toISOString()).lte('appointment_time', future.toISOString())
  return data || []
}
export async function markReminderSent(id) {
  await supabase.from('appointments').update({ reminder_sent: true }).eq('id', id)
}

// ── Payments ──────────────────────────────────────────
export async function createPayment(data) {
  const { data: payment, error } = await supabase.from('payments').insert(data).select().single()
  return { payment, error }
}
export async function getPaymentById(id) {
  const { data } = await supabase.from('payments')
    .select('*, customers(name, phone), businesses(name, upi_id, whatsapp_phone_id)')
    .eq('id', id).single()
  return data
}
export async function getPendingPayments(businessId, { limit = 500 } = {}) {
  const capped = Math.max(1, Math.min(2000, Number(limit) || 500))
  const { data } = await supabase.from('payments').select('*, customers(name, phone)')
    .eq('business_id', businessId).eq('status', 'pending')
    .order('due_date')
    .limit(capped)
  return data || []
}
export async function markPaymentPaid(id) {
  const { error } = await supabase.from('payments').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', id)
  return { error }
}
export async function markPaymentReminderSent(id) {
  await supabase.from('payments').update({ reminder_sent: true }).eq('id', id)
}
export async function getOverduePayments(daysOverdue = 1) {
  // Pull payments overdue by at least `daysOverdue` (a low floor); the scheduler
  // then applies each business's own payment_reminder_days threshold.
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - daysOverdue)
  const { data } = await supabase.from('payments')
    .select('*, customers(name, phone), businesses(name, upi_id, whatsapp_phone_id, payment_reminder_days)')
    .eq('status', 'pending').eq('reminder_sent', false).lte('due_date', cutoff.toISOString())
  return data || []
}

// ── Stats ─────────────────────────────────────────────
export async function getDashboardStats(businessId) {
  const startOfDay = istMidnightUtc(istDateStr())
  const endOfDay   = istEndOfDayUtc(istDateStr())
  const [appts, payments, messages, newCust] = await Promise.all([
    supabase.from('appointments').select('id').eq('business_id', businessId)
      .gte('appointment_time', startOfDay).lte('appointment_time', endOfDay),
    supabase.from('payments').select('amount').eq('business_id', businessId).eq('status', 'pending'),
    supabase.from('messages').select('id').eq('business_id', businessId)
      .gte('created_at', startOfDay).lte('created_at', endOfDay).eq('role', 'assistant'),
    supabase.from('customers').select('id').eq('business_id', businessId)
      .gte('created_at', startOfDay).lte('created_at', endOfDay),
  ])
  const pendingAmount = (payments.data || []).reduce((s, p) => s + Number(p.amount), 0)
  return { todayAppointments: appts.data?.length || 0, pendingPayments: pendingAmount, aiRepliesToday: messages.data?.length || 0, newCustomersToday: newCust.data?.length || 0 }
}

// ── Booking-failure alerts ────────────────────────────
// Recorded every time the extractor/validator can't complete a booking so
// the business owner can act manually. `reason` maps to validator codes
// (capacity_full, closed_day, holiday, past_datetime, outside_hours,
// after_cutoff, unknown_service, duplicate, conflict, missing_datetime) or
// pipeline codes (llm_error, extractor_failed, ambiguous).
export async function createBookingAlert(fields) {
  // Trim snippets so we don't store multi-KB payloads for every failed booking.
  const clip = (s) => (s == null ? null : String(s).slice(0, 500))
  const payload = {
    business_id:       fields.business_id,
    customer_id:       fields.customer_id,
    reason:            fields.reason,
    message_snippet:   clip(fields.message_snippet),
    ai_reply_snippet:  clip(fields.ai_reply_snippet),
    suggested_service: fields.suggested_service || null,
    suggested_date:    fields.suggested_date || null,
    suggested_time:    fields.suggested_time || null,
  }
  const { data, error } = await supabase.from('booking_alerts').insert(payload).select().single()
  if (error) console.error('createBookingAlert failed:', error.message)
  return { alert: data, error }
}

export async function getBookingAlerts(businessId, { status = 'open', limit = 50, cursor = null } = {}) {
  const capped = Math.max(1, Math.min(200, Number(limit) || 50))
  let q = supabase.from('booking_alerts')
    .select('*, customers(name, phone)')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(capped + 1)
  if (status && status !== 'all') q = q.eq('status', status)
  if (cursor) {
    const { data: anchor } = await supabase.from('booking_alerts').select('created_at, id').eq('id', cursor).single()
    if (anchor) q = q.or(`created_at.lt.${anchor.created_at},and(created_at.eq.${anchor.created_at},id.lt.${anchor.id})`)
  }
  const { data } = await q
  const rows = data || []
  const hasMore = rows.length > capped
  const page = hasMore ? rows.slice(0, capped) : rows
  return { alerts: page, nextCursor: hasMore ? page[page.length - 1].id : null }
}

export async function countOpenBookingAlerts(businessId) {
  const { count } = await supabase.from('booking_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId).eq('status', 'open')
  return count || 0
}

export async function updateBookingAlertStatus(id, businessId, status) {
  const { error } = await supabase.from('booking_alerts')
    .update({ status, handled_at: new Date().toISOString() })
    .eq('id', id).eq('business_id', businessId)
  return { error }
}

export async function getBookingAlert(id, businessId) {
  const { data } = await supabase.from('booking_alerts')
    .select('*, customers(name, phone)')
    .eq('id', id).eq('business_id', businessId).single()
  return data
}

function timeAgo(date) {
  const diff = Math.floor((Date.now() - new Date(date).getTime()) / 60000)
  if (diff < 1) return 'just now'
  if (diff < 60) return `${diff}m ago`
  if (diff < 1440) return `${Math.floor(diff/60)}h ago`
  return `${Math.floor(diff/1440)}d ago`
}