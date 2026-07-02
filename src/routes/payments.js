import { Router } from 'express'
import { getPaymentById, markPaymentPaid, markPaymentReminderSent, saveMessage } from '../config/database.js'
import { sendMessage } from '../services/whatsappService.js'
import { paymentReminder } from '../services/aiService.js'

export const paymentsRouter = Router()

// Send payment reminder — now looks up by ID directly (fixes wrong-phone bug)
paymentsRouter.post('/:id/remind', async (req, res) => {
  try {
    const payment = await getPaymentById(req.params.id)
    if (!payment) return res.status(404).json({ error: 'Payment not found' })
    if (!payment.customers?.phone) return res.status(400).json({ error: 'Customer has no phone' })

    const daysOverdue = Math.floor((Date.now() - new Date(payment.due_date).getTime()) / 86400000)
    const msg = paymentReminder(payment, daysOverdue)

    const phoneId = payment.businesses?.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID
    const result  = await sendMessage(payment.customers.phone, msg, phoneId)

    if (result.success) {
      await markPaymentReminderSent(payment.id)
      await saveMessage(payment.business_id, payment.customer_id, 'assistant', msg)
      res.json({ success: true })
    } else {
      // Surface the real WhatsApp error (e.g. 24-hour window)
      res.status(400).json({ success: false, error: result.error || 'WhatsApp send failed' })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

paymentsRouter.patch('/:id/paid', async (req, res) => {
  const { error } = await markPaymentPaid(req.params.id)
  if (error) return res.status(400).json({ error: error.message })
  res.json({ success: true })
})