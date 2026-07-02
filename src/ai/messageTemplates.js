// ── Language detection ────────────────────────────────
// Cheap heuristic: mark a message as Hinglish/Hindi if it contains
// devanagari characters OR common Hinglish tokens. Everything else is
// treated as English. Not perfect, but covers the WhatsApp cases well.
const HINGLISH_TOKENS = /\b(namaste|aap|aapka|aapke|aapki|hum|kya|kab|kahan|kaun|kaunsi|kaunsa|kaise|kar|karna|karo|karein|hai|hain|ho|ka|ki|ke|mein|se|par|liye|chahiye|chalega|nahi|haan|ji|kal|aaj|parson|subah|dopahar|shaam|raat|baje|book|dhanyavaad|shukriya|thoda|jaldi|band|khula)\b/i
const DEVANAGARI = /[ऀ-ॿ]/

export function detectLanguage(text) {
  if (!text) return 'en'
  if (DEVANAGARI.test(text)) return 'hi'
  if (HINGLISH_TOKENS.test(text)) return 'hi'
  return 'en'
}

// ── Appointment reminder ──────────────────────────────
export function appointmentReminder(appt, lang = 'hi') {
  const dt   = new Date(appt.appointment_time)
  const time = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
  const date = dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
  const name = appt.customers?.name ? ` ${appt.customers.name}${lang === 'hi' ? ' ji' : ''}` : ''
  if (lang === 'en') {
    return `📅 Reminder!\n\nHi${name}!\n\nYour appointment at *${appt.businesses?.name}*:\n🕐 ${date} at ${time}\n💆 ${appt.service}\n\nSee you on time! 🙏`
  }
  return `📅 Reminder!\n\nNamaste${name}!\n\nAppointment at *${appt.businesses?.name}*:\n🕐 ${date} at ${time}\n💆 ${appt.service}\n\nPlease be on time! 🙏`
}

// ── Payment reminder ──────────────────────────────────
export function paymentReminder(payment, daysOverdue, lang = 'hi') {
  const rawName = payment.customers?.name || ''
  const name = rawName ? `${rawName}${lang === 'hi' ? ' ji' : ''}` : (lang === 'hi' ? 'ji' : 'there')
  const upi  = payment.businesses?.upi_id || 'Contact us'
  const biz  = payment.businesses?.name || 'our business'
  const amt  = `₹${Number(payment.amount).toLocaleString('en-IN')}`
  const desc = payment.description ? ` (${payment.description})` : ''
  if (lang === 'en') {
    return daysOverdue <= 3
      ? `Hi ${name}! 🙏\n\n*${biz}* payment reminder:\n💰 Amount: ${amt}${desc}\n💳 UPI: *${upi}*\n\nThank you! 😊`
      : `Hi ${name}! 🙏\n\nYou have a pending payment of ${amt}${desc} at *${biz}*.\n💳 UPI: *${upi}*\n\nPlease clear this at your earliest 🙏`
  }
  return daysOverdue <= 3
    ? `Namaste ${name}! 🙏\n\n*${biz}* payment reminder:\n💰 Amount: ${amt}${desc}\n💳 UPI: *${upi}*\n\nThank you! 😊`
    : `Namaste ${name}! 🙏\n\nAapka *${biz}* mein ${amt}${desc} pending hai.\n💳 UPI: *${upi}*\n\nKripya jald payment karein 🙏`
}

// ── Re-engagement ─────────────────────────────────────
export function reengagementMessage(customer, business, lang = 'hi') {
  const rawName = customer.name || ''
  const name = rawName ? `${rawName}${lang === 'hi' ? ' ji' : ''}` : (lang === 'hi' ? 'ji' : 'there')
  if (lang === 'en') {
    return `Hi ${name}! 🙏\nWe miss you at *${business.name}*!\nReply if you'd like to book an appointment 😊`
  }
  return `Namaste ${name}! 🙏\nHum aapko *${business.name}* mein miss kar rahe hain!\nAppointment book karni ho toh reply karein 😊`
}

// ── Correction message when the LLM said "✅ Booked" but the backend
// validator refused the slot (capacity / holiday / conflict etc). Sent
// AFTER the ✅ so the customer isn't left thinking they're booked. ──
export function bookingRejectedMessage(code, slot, business, lang = 'hi') {
  const time = slot?.time || ''
  const cap  = business?.hourly_capacity
  if (lang === 'en') {
    switch (code) {
      case 'capacity_full':  return `Sorry 🙏 that hour is fully booked (max ${cap} per hour). Would another time work?`
      case 'conflict':       return `Sorry 🙏 that slot was just taken. Could you pick a different time?`
      case 'duplicate':      return `You already have this slot booked 😊 Let me know if you'd like a different time.`
      case 'past_datetime':  return `Sorry 🙏 that time has passed. Could you pick an upcoming time?`
      case 'closed_day':     return `Sorry 🙏 we're closed that day. Any open day that works for you?`
      case 'holiday':        return `Sorry 🙏 that's a holiday for us. Could we try a different day?`
      case 'outside_hours':  return `Sorry 🙏 ${time} is outside our working hours. Any time within working hours?`
      case 'after_cutoff':   return `Sorry 🙏 that's past our last-booking cutoff. Could you pick a slightly earlier time?`
      case 'unknown_service':return `Sorry 🙏 that service isn't on our list. Which one would you like to book?`
      default:               return `Sorry 🙏 that slot couldn't be confirmed. Could you pick a different time?`
    }
  }
  switch (code) {
    case 'capacity_full':  return `Sorry 🙏 us hour mein saari slots book ho chuki hain (max ${cap} per hour). Koi doosra time chalega?`
    case 'conflict':       return `Sorry 🙏 wo slot abhi kisi aur ne le liya. Aap koi doosra time bata sakte hain?`
    case 'duplicate':      return `Aap ye slot pehle se book kar chuke hain 😊 Koi aur time chahiye toh bataiye.`
    case 'past_datetime':  return `Sorry 🙏 wo time nikal chuka hai. Aap koi upcoming time bata sakte hain?`
    case 'closed_day':     return `Sorry 🙏 us din hum band rehte hain. Kisi open day mein aana chahenge?`
    case 'holiday':        return `Sorry 🙏 us din holiday hai. Kisi doosre din try karein?`
    case 'outside_hours':  return `Sorry 🙏 ${time} hamare working hours ke bahar hai. Working hours mein koi time bata sakte hain?`
    case 'after_cutoff':   return `Sorry 🙏 hamari last booking hamare cutoff time tak hoti hai. Aap thoda pehle ka time bata sakte hain?`
    case 'unknown_service':return `Sorry 🙏 ye service hamari list mein nahi hai. Kaunsi service book karni hai?`
    default:               return `Sorry 🙏 wo slot confirm nahi ho paaya. Aap koi doosra time bata sakte hain?`
  }
}
