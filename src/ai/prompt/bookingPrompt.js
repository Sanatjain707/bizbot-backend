import { formatLastBooking } from './formatters.js'

export function buildBookingWindowPrompt(business) {
  const lastBooking = formatLastBooking(business)
  // Example-backed rules hold better than bare rules. The cutoff lines only
  // appear when a last booking time is set; the closed-day rule always applies.
  return `BOOKING WINDOW (follow strictly when offering OR accepting a slot):
- Only offer or confirm slots inside the working hours listed above.
- NEVER offer or confirm a slot on a day marked "Closed" — suggest the nearest open day instead.${lastBooking ? `
- The LAST booking time is ${lastBooking}. NEVER offer or accept any slot later than ${lastBooking}, even on days that close later.
- If a customer asks for a time after ${lastBooking}, politely decline and offer ${lastBooking} (or an earlier open slot).` : ''}

Examples:${lastBooking ? `
- Customer asks for a slot after ${lastBooking}: "Sorry ji, hamari last booking ${lastBooking} tak hoti hai 🙏 ${lastBooking} chalega? 😊"` : ''}
- Customer asks for a day that is marked Closed: "Us din hum band rehte hain 🙏 [nearest open day] ko aa sakte hain? 😊"`
}
