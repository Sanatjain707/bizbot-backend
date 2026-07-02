import { createPayment } from '../config/database.js'
import { callGroq } from './groqClient.js'

// ── Create a payment record when a service price is known ──
export async function tryCreatePayment(business, customer, serviceName) {
  if (!serviceName) return
  try {
    let amount = 0

    // 1. Try structured services_list first (exact match, no AI needed)
    if (Array.isArray(business.services_list)) {
      const match = business.services_list.find(
        s => s.name?.toLowerCase().trim() === serviceName.toLowerCase().trim()
      )
      if (match?.price) amount = Number(match.price)
    }

    // 2. Fallback to AI extraction from old pricing text
    if (!amount && business.pricing) {
      const pricePrompt = `Price list: "${business.pricing}"
Service booked: "${serviceName}"
Return ONLY the numeric price (digits only) for that service. If not found, return 0. No text, no symbol.`
      const priceRaw = await callGroq('You extract a single number. Return only digits.', [], pricePrompt, {
        maxTokens: 20,
        temperature: 0,
      })
      amount = parseInt(String(priceRaw).replace(/\D/g, '')) || 0
    }

    if (!amount || amount <= 0) return

    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 1)

    await createPayment({
      business_id:   business.id,
      customer_id:   customer.id,
      amount,
      description:   serviceName,
      due_date:      dueDate.toISOString(),
      status:        'pending',
      reminder_sent: false
    })
    console.log('💰 Payment record created')
  } catch (err) {
    console.error('⚠️ Payment creation skipped:', err.message)
  }
}
