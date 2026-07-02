// Payment service — creates pending payments when a service has a known price.
// Extracted from the old ai/paymentManager.js so aiService stays a thin
// orchestrator and payment logic can be exercised independently in tests.

import { createPayment } from '../config/database.js'
import { callGroq } from '../ai/groqClient.js'
import { findService } from '../ai/validator.js'
import { addDaysISO, istDateStr, istEndOfDayUtc } from '../utils/dateTime.js'

// Resolve a price for the service. Prefers structured services_list;
// falls back to LLM extraction from free-text pricing only if needed.
async function resolveAmount(business, serviceName) {
  if (!serviceName) return 0
  const match = findService(business, serviceName)
  if (match?.price) return Number(match.price) || 0

  if (!business?.pricing) return 0
  const pricePrompt = `Price list: "${business.pricing}"
Service booked: "${serviceName}"
Return ONLY the numeric price (digits only) for that service. If not found, return 0. No text, no symbol.`
  const raw = await callGroq(
    'You extract a single number. Return only digits.',
    [],
    pricePrompt,
    { maxTokens: 20, temperature: 0 },
  )
  return parseInt(String(raw).replace(/\D/g, ''), 10) || 0
}

export async function tryCreatePayment(business, customer, serviceName) {
  if (!serviceName) return null
  try {
    const amount = await resolveAmount(business, serviceName)
    if (!amount || amount <= 0) return null

    const dueDate = istEndOfDayUtc(addDaysISO(istDateStr(), 1))

    const { payment } = await createPayment({
      business_id:   business.id,
      customer_id:   customer.id,
      amount,
      description:   serviceName,
      due_date:      dueDate,
      status:        'pending',
      reminder_sent: false,
    })
    console.log('💰 Payment record created')
    return payment
  } catch (err) {
    console.error('⚠️ Payment creation skipped:', err.message)
    return null
  }
}
