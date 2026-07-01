import { Router } from 'express'
import {
  getDashboardStats, getTodayAppointments, getAllAppointments,
  updateAppointmentStatus, getConversations, getMessages,
  getPendingPayments, getAllCustomers, getOrCreateCustomer,
  createAppointment, supabase, saveMessage, normalizePhone
} from '../config/database.js'
import { sendMessage } from '../services/whatsappService.js'
import { appointmentReminder } from '../services/aiService.js'

export const dashboardRouter = Router()
const bid = req => req.headers['x-business-id']

// ── Stats ─────────────────────────────────────────────
dashboardRouter.get('/stats', async (req, res) => {
  if (!bid(req)) return res.status(400).json({ error: 'x-business-id required' })
  res.json(await getDashboardStats(bid(req)))
})

// ── Appointments ──────────────────────────────────────
dashboardRouter.get('/appointments/today', async (req, res) => {
  res.json(await getTodayAppointments(bid(req)))
})
dashboardRouter.get('/appointments', async (req, res) => {
  res.json(await getAllAppointments(bid(req)))
})
dashboardRouter.patch('/appointments/:id', async (req, res) => {
  const { status } = req.body
  // If marking done, increment customer visit count
  if (status === 'done') {
    const { data: appt } = await supabase.from('appointments').select('customer_id').eq('id', req.params.id).single()
    if (appt?.customer_id) {
      const { data: cust } = await supabase.from('customers').select('total_visits').eq('id', appt.customer_id).single()
      await supabase.from('customers').update({ total_visits: (cust?.total_visits || 0) + 1 }).eq('id', appt.customer_id)
    }
  }
  const { error } = await updateAppointmentStatus(req.params.id, status)
  if (error) return res.status(400).json({ error: error.message })
  res.json({ success: true })
})
dashboardRouter.post('/appointments/create', async (req, res) => {
  const businessId = bid(req)
  const { customer_name, customer_phone, service, appointment_time, notes, status } = req.body
  try {
    const phone    = customer_phone || `manual-${Date.now()}`
    const customer = await getOrCreateCustomer(businessId, phone, customer_name)
    const appt = await createAppointment({
      business_id: businessId, customer_id: customer.id,
      service: service || 'Appointment', appointment_time,
      status: status || 'confirmed', reminder_sent: false, notes: notes || null
    })
    res.status(201).json(appt)
  } catch (err) { res.status(500).json({ error: err.message }) }
})
dashboardRouter.post('/appointments/:id/remind', async (req, res) => {
  try {
    const { data: appt } = await supabase.from('appointments')
      .select('*, customers(name, phone), businesses(name, whatsapp_phone_id)')
      .eq('id', req.params.id).single()
    if (!appt) return res.status(404).json({ error: 'Not found' })
    const msg = appointmentReminder(appt)
    const result = await sendMessage(appt.customers.phone, msg, appt.businesses.whatsapp_phone_id)
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
    const today = new Date().toISOString().split('T')[0]   // same UTC boundary as getTodayAppointments
    const { data: appts } = await supabase.from('appointments')
      .select('*, customers(name, phone)')
      .eq('business_id', businessId).eq('status', 'confirmed')
      .gte('appointment_time', `${today}T00:00:00`).lte('appointment_time', `${today}T23:59:59`)
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
      const r = await sendMessage(phone, appointmentReminder({ ...appt, businesses: business }), business.whatsapp_phone_id)
      if (r.success) sent++
      else if (r.errorCode === 131047) windowFailed++    // outside the 24h service window
      else otherFailed++
    }
    res.json({ total: recipients.length, sent, windowFailed, otherFailed })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Conversations ─────────────────────────────────────
dashboardRouter.get('/conversations', async (req, res) => {
  res.json(await getConversations(bid(req)))
})
dashboardRouter.get('/conversations/:cid/messages', async (req, res) => {
  res.json(await getMessages(req.params.cid))
})
// Manual reply from dashboard
dashboardRouter.post('/conversations/:cid/send', async (req, res) => {
  const businessId = bid(req)
  const { text } = req.body
  try {
    const { data: customer } = await supabase.from('customers')
      .select('*, businesses(whatsapp_phone_id)').eq('id', req.params.cid).single()
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
  const { data: customer } = await supabase.from('customers').select('*').eq('id', req.params.id).single()
  const { data: appts }    = await supabase.from('appointments').select('*').eq('customer_id', req.params.id).order('appointment_time', { ascending: false })
  const { data: payments } = await supabase.from('payments').select('*').eq('customer_id', req.params.id)
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
  try {
    const { data: customer } = await supabase.from('customers')
      .select('*, businesses(name, whatsapp_phone_id)').eq('id', req.params.id).single()
    if (!customer) return res.status(404).json({ error: 'Not found' })
    const name = customer.name ? `${customer.name} ji` : 'ji'
    const msg  = `Namaste ${name}! 🙏\nHum aapko *${customer.businesses?.name}* mein miss kar rahe hain!\nAppointment book karni ho toh reply karein 😊`
    const result = await sendMessage(customer.phone, msg, customer.businesses?.whatsapp_phone_id)
    if (result.success) await supabase.from('customers').update({ reengagement_sent: true }).eq('id', req.params.id)
    res.json({ success: result.success })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Toggle AI on/off for a conversation ───────────────
dashboardRouter.patch('/conversations/:cid/ai', async (req, res) => {
  const { ai_enabled } = req.body
  const { error } = await supabase.from('customers').update({ ai_enabled }).eq('id', req.params.cid)
  if (error) return res.status(400).json({ error: error.message })
  res.json({ success: true })
})