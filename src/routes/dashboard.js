import { Router } from 'express'
import {
  getDashboardStats, getTodayAppointments, getAllAppointments,
  updateAppointmentStatus, getConversations, getMessages,
  getPendingPayments, getAllCustomers, getOrCreateCustomer,
  createAppointment, supabase, saveMessage
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