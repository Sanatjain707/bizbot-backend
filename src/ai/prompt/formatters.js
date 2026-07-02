export function formatServices(business) {
  const list = business.services_list
  if (Array.isArray(list) && list.length > 0) {
    // One bulleted line per service (WhatsApp-friendly), grouped by category
    const byCat = {}
    for (const s of list) {
      const cat = s.category || 'Services'
      if (!byCat[cat]) byCat[cat] = []
      let line = `• ${s.name} — ₹${s.price}`
      if (s.duration) line += ` (${s.duration})`
      if (s.details)  line += ` — ${s.details}`
      byCat[cat].push(line)
    }
    const cats = Object.entries(byCat)
    // Single default category → plain bullet list; multiple → bold category headers
    if (cats.length === 1 && cats[0][0] === 'Services') return cats[0][1].join('\n')
    return cats.map(([cat, items]) => `*${cat}*\n${items.join('\n')}`).join('\n\n')
  }
  // Fallback to old text fields
  return `${business.services || 'Ask owner'}\nPricing: ${business.pricing || 'Contact for pricing'}`
}

export function formatHours(business) {
  const h = business.business_hours
  if (h && typeof h === 'object' && Object.keys(h).length) {
    const names = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun' }
    const order = ['mon','tue','wed','thu','fri','sat','sun']
    const parts = []
    for (const d of order) {
      const day = h[d]
      if (!day) continue
      if (day.closed) parts.push(`${names[d]}: Closed`)
      else parts.push(`${names[d]}: ${day.open}-${day.close}`)
    }
    if (parts.length) return parts.join(', ')
  }
  // fallback to old free-text field
  return business.working_hours || '9am-8pm Mon-Sat'
}

// "16:30" → "4:30 PM". Returns null when no last booking time is set.
export function formatLastBooking(business) {
  const raw = business.last_booking_time
  if (!raw || typeof raw !== 'string' || !raw.includes(':')) return null
  const [hStr, mStr] = raw.split(':')
  const h = parseInt(hStr, 10), m = parseInt(mStr, 10)
  if (isNaN(h) || isNaN(m)) return null
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}
