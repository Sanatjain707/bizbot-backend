import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

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
  let { data } = await supabase.from('customers').select('*').eq('business_id', businessId).eq('phone', normPhone).single()
  if (data) {
    const update = { last_seen: new Date().toISOString() }
    if (name && !data.name) update.name = name  // fill name if we now have one
    await supabase.from('customers').update(update).eq('id', data.id)
    return data
  }
  const { data: created } = await supabase.from('customers').insert({ business_id: businessId, phone: normPhone, name, last_seen: new Date().toISOString() }).select().single()
  return created
}
export async function updateCustomerName(id, name) {
  await supabase.from('customers').update({ name }).eq('id', id)
}
export async function getAllCustomers(businessId) {
  const { data } = await supabase.from('customers').select('*').eq('business_id', businessId).order('last_seen', { ascending: false })
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
export async function getConversations(businessId) {
  const { data: customers } = await supabase.from('customers').select('id, name, phone, last_seen, ai_enabled').eq('business_id', businessId).order('last_seen', { ascending: false }).limit(50)
  if (!customers) return []
  const result = []
  for (const c of customers) {
    const { data: msgs } = await supabase.from('messages').select('role, content, created_at').eq('customer_id', c.id).order('created_at', { ascending: false }).limit(1)
    result.push({ id: c.id, phone: c.phone, name: c.name, ai_enabled: c.ai_enabled !== false, last_msg: msgs?.[0]?.content?.slice(0, 60) || '', last_time: timeAgo(c.last_seen), unread: msgs?.[0]?.role === 'user' ? 1 : 0 })
  }
  return result
}
export async function getMessages(customerId) {
  const { data } = await supabase.from('messages').select('*').eq('customer_id', customerId).order('created_at', { ascending: true })
  return data || []
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
  const today = new Date().toISOString().split('T')[0]
  const { data } = await supabase.from('appointments').select('*, customers(name, phone)').eq('business_id', businessId).gte('appointment_time', `${today}T00:00:00`).lte('appointment_time', `${today}T23:59:59`).order('appointment_time')
  return data || []
}
export async function getAllAppointments(businessId) {
  const { data } = await supabase.from('appointments').select('*, customers(name, phone)').eq('business_id', businessId).order('appointment_time', { ascending: false })
  return data || []
}
export async function updateAppointmentStatus(id, status) {
  const { error } = await supabase.from('appointments').update({ status }).eq('id', id)
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
export async function getPendingPayments(businessId) {
  const { data } = await supabase.from('payments').select('*, customers(name, phone)').eq('business_id', businessId).eq('status', 'pending').order('due_date')
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
  const today = new Date().toISOString().split('T')[0]
  const [appts, payments, messages, newCust] = await Promise.all([
    supabase.from('appointments').select('id').eq('business_id', businessId).gte('appointment_time', `${today}T00:00:00`),
    supabase.from('payments').select('amount').eq('business_id', businessId).eq('status', 'pending'),
    supabase.from('messages').select('id').eq('business_id', businessId).gte('created_at', `${today}T00:00:00`).eq('role', 'assistant'),
    supabase.from('customers').select('id').eq('business_id', businessId).gte('created_at', `${today}T00:00:00`),
  ])
  const pendingAmount = (payments.data || []).reduce((s, p) => s + Number(p.amount), 0)
  return { todayAppointments: appts.data?.length || 0, pendingPayments: pendingAmount, aiRepliesToday: messages.data?.length || 0, newCustomersToday: newCust.data?.length || 0 }
}

function timeAgo(date) {
  const diff = Math.floor((Date.now() - new Date(date).getTime()) / 60000)
  if (diff < 1) return 'just now'
  if (diff < 60) return `${diff}m ago`
  if (diff < 1440) return `${Math.floor(diff/60)}h ago`
  return `${Math.floor(diff/1440)}d ago`
}