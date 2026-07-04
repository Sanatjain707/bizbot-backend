import { Router } from 'express'
import {
  getDashboardStats, getTodayAppointments, getAllAppointments,
  getAppointmentsPage, updateAppointmentStatus, getConversations,
  getMessages, getMessagesPage,
  getPendingPayments, getAllCustomers, getOrCreateCustomer,
  createAppointment, supabase, saveMessage, normalizePhone,
  getBookingAlerts, countOpenBookingAlerts, updateBookingAlertStatus, getBookingAlert,
} from '../config/database.js'
import { validateBooking } from '../ai/validator.js'
import { sendMessage } from '../services/whatsappService.js'
import { appointmentReminder } from '../services/aiService.js'
import { detectLanguage } from '../ai/messageTemplates.js'
import { istDateStr, istMidnightUtc, istEndOfDayUtc } from '../utils/dateTime.js'

// One query per customer — reminders are low-frequency, so this is fine.
async function pickLang(customerId) {
  const { data } = await supabase.from('messages')
    .select('content').eq('customer_id', customerId).eq('role', 'user')
    .order('created_at', { ascending: false }).limit(1)
  return detectLanguage(data?.[0]?.content || '')
}

export const dashboardRouter = Router()
const bid = req => req.headers['x-business-id']

// ── Stats ─────────────────────────────────────────────
dashboardRouter.get('/stats', async (req, res) => {
  if (!bid(req)) return res.status(400).json({ error: 'x-business-id required' })
  // openAlerts was joined here for an overview badge that no frontend consumes —
  // the sidebar gets its count from /booking-alerts/count. Dropped the redundant
  // per-stats query. Re-add if an overview badge is built.
  res.json(await getDashboardStats(bid(req)))
})

// ── Booking alerts ────────────────────────────────────
// Records of bookings the AI couldn't complete (validator rejection, LLM
// error, ambiguous input). Owner uses these to close the loop manually.
// ?status=open|handled|dismissed|all&limit=50&cursor=<id>
dashboardRouter.get('/booking-alerts', async (req, res) => {
  const { status, limit, cursor } = req.query
  const result = await getBookingAlerts(bid(req), {
    status: status || 'open',
    limit:  limit ? Number(limit) : 50,
    cursor: cursor || null,
  })
  res.json(result)
})

dashboardRouter.get('/booking-alerts/count', async (req, res) => {
  res.json({ open: await countOpenBookingAlerts(bid(req)) })
})

// Mark handled (the owner acted on it) or dismissed (false alarm / ignore).
dashboardRouter.patch('/booking-alerts/:id', async (req, res) => {
  const businessId = bid(req)
  const status = String(req.body?.status || '').trim()
  if (!['handled', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status must be handled or dismissed' })
  }
  const { error } = await updateBookingAlertStatus(req.params.id, businessId, status)
  if (error) return res.status(400).json({ error: error.message })
  res.json({ success: true })
})

// One-click "create the appointment the AI failed to book" — accepts the
// same body as POST /appointments/create plus links back to the alert so
// it gets marked handled automatically.
dashboardRouter.post('/booking-alerts/:id/create-appointment', async (req, res) => {
  const businessId = bid(req)
  try {
    const alert = await getBookingAlert(req.params.id, businessId)
    if (!alert) return res.status(404).json({ error: 'Alert not found' })

    const { customer_name, customer_phone, service, appointment_time, notes, status } = req.body
    const phone = customer_phone || alert.customers?.phone || `manual-${Date.now()}`
    const customer = await getOrCreateCustomer(businessId, phone, customer_name || alert.customers?.name)
    const appt = await createAppointment({
      business_id: businessId,
      customer_id: customer.id,
      service:     service || alert.suggested_service || 'Appointment',
      appointment_time,
      status:      status || 'confirmed',
      reminder_sent: false,
      notes: notes || null,
    })
    // Best-effort: don't fail the appointment if the alert update fails.
    updateBookingAlertStatus(req.params.id, businessId, 'handled').catch(() => {})
    res.status(201).json(appt)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Appointments ──────────────────────────────────────
dashboardRouter.get('/appointments/today', async (req, res) => {
  res.json(await getTodayAppointments(bid(req)))
})
// Paginated list. Accepts ?cursor=<id>&limit=50 and optional filters:
// ?status=confirmed&from=2026-07-01T00:00:00Z&to=2026-07-31T23:59:59Z
// &customer_id=<uuid>&service=Facial
// Response: { appointments: [...], nextCursor: <id|null> }
dashboardRouter.get('/appointments', async (req, res) => {
  const { cursor, limit, status, from, to, customer_id, service } = req.query
  // Legacy consumers can request the old flat array with ?paginated=false
  if (req.query.paginated === 'false') {
    return res.json(await getAllAppointments(bid(req)))
  }
  const filters = {}
  if (status) filters.status = String(status)
  if (from)   filters.from = String(from)
  if (to)     filters.to = String(to)
  if (customer_id) filters.customerId = String(customer_id)
  if (service) filters.service = String(service)
  const page = await getAppointmentsPage(bid(req), {
    cursor: cursor || null,
    limit: limit ? Number(limit) : 50,
    filters,
  })
  res.json(page)
})
dashboardRouter.patch('/appointments/:id', async (req, res) => {
  const businessId = bid(req)
  const { status } = req.body
  // Verify the appointment belongs to this business BEFORE any side-effects.
  const { data: appt } = await supabase.from('appointments')
    .select('customer_id, business_id').eq('id', req.params.id).single()
  if (!appt || appt.business_id !== businessId) {
    return res.status(404).json({ error: 'Appointment not found' })
  }
  // If marking done, atomically bump visit count via SQL rather than read+write.
  if (status === 'done' && appt.customer_id) {
    await supabase.rpc('increment_customer_visits', { p_customer_id: appt.customer_id })
      .catch(err => console.error('visit count bump failed:', err.message))
  }
  const { error } = await updateAppointmentStatus(req.params.id, status, businessId)
  if (error) return res.status(400).json({ error: error.message })
  res.json({ success: true })
})
dashboardRouter.post('/appointments/create', async (req, res) => {
  const businessId = bid(req)
  const { customer_name, customer_phone, service, appointment_time, notes, status } = req.body
  try {
    const phone    = customer_phone || `manual-${Date.now()}`
    const customer = await getOrCreateCustomer(businessId, phone, customer_name)

    // Dashboard bookings go through the same validator as the AI path so a
    // business owner can't manually create a slot that violates their own rules.
    // We accept a full ISO string; split it into IST date+time for the validator.
    if (appointment_time) {
      const { data: business } = await supabase.from('businesses').select('*').eq('id', businessId).single()
      const utc = new Date(appointment_time)
      const ist = new Date(utc.getTime() + (5 * 60 + 30) * 60 * 1000)
      const dateISO = ist.toISOString().slice(0, 10)
      const hhmm    = ist.toISOString().slice(11, 16)
      const check = await validateBooking({ business, customer, dateISO, hhmm, service })
      if (!check.valid) return res.status(400).json({ error: check.error, code: check.code })
    }

    const appt = await createAppointment({
      business_id: businessId, customer_id: customer.id,
      service: service || 'Appointment', appointment_time,
      status: status || 'confirmed', reminder_sent: false, notes: notes || null
    })
    res.status(201).json(appt)
  } catch (err) { res.status(500).json({ error: err.message }) }
})
dashboardRouter.post('/appointments/:id/remind', async (req, res) => {
  const businessId = bid(req)
  try {
    // Scope by business_id so an attacker with a valid session can't
    // trigger a reminder for another tenant's appointment.
    const { data: appt } = await supabase.from('appointments')
      .select('*, customers(name, phone), businesses(name, whatsapp_phone_id)')
      .eq('id', req.params.id).eq('business_id', businessId).single()
    if (!appt) return res.status(404).json({ error: 'Not found' })
    const lang = await pickLang(appt.customer_id)
    const msg = appointmentReminder(appt, lang)
    const result = await sendMessage(appt.customers.phone, msg, appt.businesses.whatsapp_phone_id)
    // Persist to the thread so the reminder shows in the conversation
    if (result.success) await saveMessage(appt.business_id, appt.customer_id, 'assistant', msg)
    res.json({ success: result.success })
  } catch (err) { res.status(500).json({ error: err.message }) }
})
// Remind everyone with a confirmed appointment TODAY (one message per customer).
// Free-form sends only reach customers inside WhatsApp's 24h service window; the
// rest are rejected with Meta code 131047. We count those separately so the UI
// can honestly report who wasn't reached instead of a blanket "Sent!".
dashboardRouter.post('/appointments/remind-all', async (req, res) => {
  const businessId = bid(req)
  if (!businessId) return res.status(400).json({ error: 'x-business-id required' })
  try {
    const today = istDateStr()
    const { data: appts } = await supabase.from('appointments')
      .select('*, customers(name, phone)')
      .eq('business_id', businessId).eq('status', 'confirmed')
      .gte('appointment_time', istMidnightUtc(today))
      .lte('appointment_time', istEndOfDayUtc(today))
      .order('appointment_time')
    const { data: business } = await supabase.from('businesses')
      .select('name, whatsapp_phone_id').eq('id', businessId).single()

    // One reminder per customer — list is time-sorted, so the earliest slot wins
    const seen = new Set()
    const recipients = []
    for (const a of appts || []) {
      const key = a.customer_id || a.customers?.phone
      if (!key || seen.has(key)) continue
      seen.add(key); recipients.push(a)
    }

    let sent = 0, windowFailed = 0, otherFailed = 0
    for (const appt of recipients) {
      const phone = appt.customers?.phone
      if (!phone || !business?.whatsapp_phone_id) { otherFailed++; continue }
      const lang = await pickLang(appt.customer_id)
      const msg = appointmentReminder({ ...appt, businesses: business }, lang)
      const r = await sendMessage(phone, msg, business.whatsapp_phone_id)
      if (r.success) { sent++; await saveMessage(businessId, appt.customer_id, 'assistant', msg) }
      else if (r.errorCode === 131047) windowFailed++    // outside the 24h service window
      else otherFailed++
    }
    res.json({ total: recipients.length, sent, windowFailed, otherFailed })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Conversations ─────────────────────────────────────
// Paginated. ?cursor=<customer_id>&limit=50&search=priya
// Response: { conversations: [...], nextCursor: <id|null> }
dashboardRouter.get('/conversations', async (req, res) => {
  const { cursor, limit, search } = req.query
  const result = await getConversations(bid(req), {
    cursor: cursor || null,
    limit: limit ? Number(limit) : 50,
    search: search || null,
  })
  res.json(result)
})
// Paginated messages for a single conversation.
// ?cursor=<message_id>&limit=50
// Legacy flat list preserved with ?paginated=false.
dashboardRouter.get('/conversations/:cid/messages', async (req, res) => {
  const businessId = bid(req)
  // Ownership check before reading messages — prevents cross-tenant thread reads.
  const { data: owner } = await supabase.from('customers')
    .select('id').eq('id', req.params.cid).eq('business_id', businessId).single()
  if (!owner) return res.status(404).json({ error: 'Conversation not found' })

  if (req.query.paginated === 'false') {
    return res.json(await getMessages(req.params.cid))
  }
  const { cursor, limit } = req.query
  res.json(await getMessagesPage(req.params.cid, {
    cursor: cursor || null,
    limit: limit ? Number(limit) : 50,
  }))
})
// Manual reply from dashboard
dashboardRouter.post('/conversations/:cid/send', async (req, res) => {
  const businessId = bid(req)
  const { text } = req.body
  try {
    // Scope by business_id — otherwise User A can send a WhatsApp on behalf
    // of Business B by supplying B's customer UUID.
    const { data: customer } = await supabase.from('customers')
      .select('*, businesses(whatsapp_phone_id)').eq('id', req.params.cid).eq('business_id', businessId).single()
    if (!customer) return res.status(404).json({ error: 'Customer not found' })

    const phoneId = customer.businesses?.whatsapp_phone_id
    const result  = await sendMessage(customer.phone, text, phoneId)
    if (result.success) await saveMessage(businessId, customer.id, 'assistant', text)
    res.json({ success: result.success })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Payments ──────────────────────────────────────────
dashboardRouter.get('/payments/pending', async (req, res) => {
  res.json(await getPendingPayments(bid(req)))
})
dashboardRouter.get('/payments/paid', async (req, res) => {
  const { data } = await supabase.from('payments')
    .select('*, customers(name, phone)')
    .eq('business_id', bid(req)).eq('status', 'paid')
    .order('paid_at', { ascending: false })
  res.json(data || [])
})
dashboardRouter.post('/payments/create', async (req, res) => {
  const businessId = bid(req)
  const { customer_name, customer_phone, amount, description, due_date } = req.body
  try {
    const phone    = customer_phone || `manual-${Date.now()}`
    const customer = await getOrCreateCustomer(businessId, phone, customer_name)
    const { data, error } = await supabase.from('payments').insert({
      business_id: businessId, customer_id: customer.id,
      amount, description, due_date, status: 'pending', reminder_sent: false
    }).select().single()
    if (error) return res.status(400).json({ error: error.message })
    res.status(201).json(data)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Customers ─────────────────────────────────────────
dashboardRouter.get('/customers', async (req, res) => {
  res.json(await getAllCustomers(bid(req)))
})
dashboardRouter.get('/customers/:id', async (req, res) => {
  const businessId = bid(req)
  // Scope every read by business_id — a customer UUID from another tenant
  // used to return that customer's full profile + appointments + payments.
  const { data: customer } = await supabase.from('customers').select('*')
    .eq('id', req.params.id).eq('business_id', businessId).single()
  if (!customer) return res.status(404).json({ error: 'Customer not found' })
  const { data: appts }    = await supabase.from('appointments').select('*')
    .eq('customer_id', req.params.id).eq('business_id', businessId)
    .order('appointment_time', { ascending: false })
  const { data: payments } = await supabase.from('payments').select('*')
    .eq('customer_id', req.params.id).eq('business_id', businessId)
  res.json({ ...customer, appointments: appts || [], payments: payments || [] })
})
dashboardRouter.post('/customers/create', async (req, res) => {
  const businessId = bid(req)
  const { name, phone } = req.body
  try {
    const customer = await getOrCreateCustomer(businessId, phone || `manual-${Date.now()}`, name)
    res.status(201).json(customer)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Bulk import customers (source-agnostic) ──
// Accepts [{name, phone}], reuses normalizePhone, dedupes against the DB and
// within the file, and bulk-inserts race-safely via the unique(business_id,phone)
// constraint. Guarantees: imported + skippedDuplicate + skippedInvalid === received.
export async function importCustomersBulk(businessId, rows) {
  // Ignore fully-empty rows entirely (not counted in `received`)
  const meaningful = rows.filter(r => String(r?.name || '').trim() || String(r?.phone || '').trim())

  // Existing phones for this business (paginated past the 1000-row cap)
  const existing = new Set()
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from('customers').select('phone').eq('business_id', businessId).range(start, start + 999)
    if (error) throw new Error(error.message)
    if (!data?.length) break
    for (const c of data) existing.add(c.phone)
    if (data.length < 1000) break
  }

  const seen = new Set()
  const toInsert = []
  const invalidRows = []
  let skippedDuplicate = 0, skippedInvalid = 0
  const now = new Date().toISOString()

  for (const r of meaningful) {
    const name     = String(r?.name  || '').trim()
    const rawPhone = String(r?.phone || '').trim()
    const phone    = normalizePhone(rawPhone)                 // reuse existing helper
    const digits   = String(phone || '').replace(/\D/g, '')
    if (digits.length < 10) {
      skippedInvalid++
      if (invalidRows.length < 100) invalidRows.push({ name, phone: rawPhone, reason: rawPhone ? 'invalid phone' : 'missing phone' })
      continue
    }
    if (existing.has(phone) || seen.has(phone)) { skippedDuplicate++; continue }
    seen.add(phone)
    toInsert.push({ business_id: businessId, phone, name: name || phone, last_seen: now })
  }

  // Race-safe bulk insert; unique(business_id,phone) conflicts are silently ignored
  let imported = 0
  for (let i = 0; i < toInsert.length; i += 500) {
    const batch = toInsert.slice(i, i + 500)
    const { data, error } = await supabase.from('customers')
      .upsert(batch, { onConflict: 'business_id,phone', ignoreDuplicates: true })
      .select('id')
    if (error) throw new Error(error.message)
    imported += data?.length || 0
  }
  // Survivors not inserted were lost to a race → still duplicates
  skippedDuplicate += (toInsert.length - imported)

  return { received: meaningful.length, imported, skippedDuplicate, skippedInvalid, invalidRows }
}

dashboardRouter.post('/customers/import', async (req, res) => {
  const businessId = bid(req)
  if (!businessId) return res.status(400).json({ error: 'x-business-id required' })
  const rows = Array.isArray(req.body?.customers) ? req.body.customers : null
  if (!rows) return res.status(400).json({ error: 'customers array required' })
  if (rows.length > 5000) return res.status(400).json({ error: 'Too many rows (max 5000 per import). Please split the file.' })
  try {
    res.json(await importCustomersBulk(businessId, rows))
  } catch (err) {
    console.error('❌ Customer import error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
// ── Delete a customer (and their data), scoped to this business ──
dashboardRouter.delete('/customers/:id', async (req, res) => {
  const businessId = bid(req)
  try {
    // Only delete if the customer belongs to this business (safety)
    const { data: customer } = await supabase.from('customers')
      .select('id, business_id').eq('id', req.params.id).single()
    if (!customer || customer.business_id !== businessId) {
      return res.status(404).json({ error: 'Customer not found' })
    }
    // Remove related rows first to avoid orphans
    await supabase.from('messages').delete().eq('customer_id', req.params.id)
    await supabase.from('appointments').delete().eq('customer_id', req.params.id)
    await supabase.from('payments').delete().eq('customer_id', req.params.id)
    const { error } = await supabase.from('customers').delete().eq('id', req.params.id)
    if (error) return res.status(400).json({ error: error.message })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

dashboardRouter.post('/customers/:id/reengage', async (req, res) => {
  const businessId = bid(req)
  try {
    // Ownership check — same class of hole as the other :id endpoints.
    const { data: customer } = await supabase.from('customers')
      .select('*, businesses(name, whatsapp_phone_id)').eq('id', req.params.id).eq('business_id', businessId).single()
    if (!customer) return res.status(404).json({ error: 'Not found' })
    const lang = await pickLang(customer.id)
    const nameSuffix = lang === 'hi' ? ' ji' : ''
    const namePart = customer.name ? `${customer.name}${nameSuffix}` : (lang === 'hi' ? 'ji' : 'there')
    const msg = lang === 'en'
      ? `Hi ${namePart}! 🙏\nWe miss you at *${customer.businesses?.name}*!\nReply if you'd like to book an appointment 😊`
      : `Namaste ${namePart}! 🙏\nHum aapko *${customer.businesses?.name}* mein miss kar rahe hain!\nAppointment book karni ho toh reply karein 😊`
    const result = await sendMessage(customer.phone, msg, customer.businesses?.whatsapp_phone_id)
    if (result.success) {
      await supabase.from('customers').update({ reengagement_sent: true }).eq('id', req.params.id)
      await saveMessage(customer.business_id, customer.id, 'assistant', msg)
    }
    res.json({ success: result.success })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Toggle AI on/off for a conversation ───────────────
dashboardRouter.patch('/conversations/:cid/ai', async (req, res) => {
  const businessId = bid(req)
  const { ai_enabled } = req.body
  // Update MUST be scoped to this business — previously an attacker could
  // silence another tenant's AI by supplying their customer UUID.
  const { error } = await supabase.from('customers')
    .update({ ai_enabled })
    .eq('id', req.params.cid).eq('business_id', businessId)
  if (error) return res.status(400).json({ error: error.message })
  res.json({ success: true })
})