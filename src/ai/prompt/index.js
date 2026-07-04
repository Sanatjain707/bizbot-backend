import { buildBookingWindowPrompt } from './bookingPrompt.js'
import { bookingRules } from './bookingRules.js'
import { conversationRules } from './conversationRules.js'
import { examples } from './examples.js'
import { formattingRules } from './formattingRules.js'
import { systemPrompt } from './systemPrompt.js'
import { validationRules } from './validationRules.js'

export function buildPrompt(business) {
  const todayStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
  const bookingWindow = buildBookingWindowPrompt(business)

  return `${systemPrompt(business, todayStr)}

${validationRules()}

${formattingRules()}

${conversationRules(business)}

${bookingRules(bookingWindow)}

${examples(business)}`
}
