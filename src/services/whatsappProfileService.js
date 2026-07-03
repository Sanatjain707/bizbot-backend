import 'dotenv/config'
import axios from 'axios'

const GRAPH = 'https://graph.facebook.com/v19.0'
const TOKEN = () => process.env.WHATSAPP_TOKEN
const phoneId = (business) => business?.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID
const metaErr = (err) => err.response?.data?.error?.error_user_msg || err.response?.data?.error?.message || err.message

// ── Read display name + review status + business profile ──
export async function getWhatsAppProfile(business) {
  const pid = phoneId(business)
  if (!pid || !TOKEN()) return { connected: false }
  const auth = { headers: { Authorization: `Bearer ${TOKEN()}` } }
  const out = { connected: true }

  try {
    const num = await axios.get(`${GRAPH}/${pid}`, {
      ...auth,
      params: { fields: 'verified_name,name_status,new_name_status,quality_rating,display_phone_number' },
    })
    out.displayName   = num.data?.verified_name || null
    out.nameStatus    = num.data?.name_status || null       // APPROVED | PENDING_REVIEW | DECLINED | NONE …
    out.newNameStatus = num.data?.new_name_status || null   // status of a pending name change
    out.qualityRating = num.data?.quality_rating || null    // GREEN | YELLOW | RED
    out.phoneNumber   = num.data?.display_phone_number || null
  } catch (err) { out.numberError = metaErr(err) }

  try {
    const prof = await axios.get(`${GRAPH}/${pid}/whatsapp_business_profile`, {
      ...auth,
      params: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' },
    })
    const p = prof.data?.data?.[0] || {}
    out.profile = {
      about: p.about || '', address: p.address || '', description: p.description || '',
      email: p.email || '', website: (p.websites || [])[0] || '', vertical: p.vertical || '',
      profilePictureUrl: p.profile_picture_url || null,
    }
  } catch (err) { out.profileError = metaErr(err) }

  return out
}

// ── Update the business profile (about/address/etc.) ──
export async function updateWhatsAppProfile(business, { about, address, description, email, website, vertical }) {
  const pid = phoneId(business)
  if (!pid || !TOKEN()) return { error: 'WhatsApp not connected for this business' }
  const body = { messaging_product: 'whatsapp' }
  if (about       !== undefined) body.about = about
  if (address     !== undefined) body.address = address
  if (description !== undefined) body.description = description
  if (email       !== undefined) body.email = email
  if (website     !== undefined) body.websites = website ? [website] : []
  if (vertical    !== undefined && vertical) body.vertical = vertical
  try {
    await axios.post(`${GRAPH}/${pid}/whatsapp_business_profile`, body, {
      headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' },
    })
    return { error: null }
  } catch (err) { return { error: metaErr(err) } }
}

// ── Upload a profile photo (logo) via the resumable upload API, then set it ──
// Three steps: start an upload session, upload the bytes to get a handle, then
// attach the handle to the business profile.
export async function updateProfilePhoto(business, buffer, mimeType) {
  const pid = phoneId(business)
  const appId = process.env.WHATSAPP_APP_ID
  if (!pid || !TOKEN()) return { error: 'WhatsApp not connected for this business' }
  if (!appId) return { error: 'Logo upload needs WHATSAPP_APP_ID set on the server' }
  try {
    const start = await axios.post(`${GRAPH}/${appId}/uploads`, null, {
      params: { file_length: buffer.length, file_type: mimeType, access_token: TOKEN() },
    })
    const sessionId = start.data?.id
    if (!sessionId) return { error: 'Could not start upload' }

    const up = await axios.post(`${GRAPH}/${sessionId}`, buffer, {
      headers: { Authorization: `OAuth ${TOKEN()}`, file_offset: 0, 'Content-Type': 'application/octet-stream' },
      maxBodyLength: Infinity,
    })
    const handle = up.data?.h
    if (!handle) return { error: 'Upload did not return an image handle' }

    await axios.post(`${GRAPH}/${pid}/whatsapp_business_profile`,
      { messaging_product: 'whatsapp', profile_picture_handle: handle },
      { headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' } })
    return { error: null }
  } catch (err) { return { error: metaErr(err) } }
}
