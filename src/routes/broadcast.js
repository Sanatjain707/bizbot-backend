import { Router } from 'express'
import { getBusinessById } from '../config/database.js'
import {
  createTemplate, listTemplates, refreshTemplateStatuses, deleteTemplate
} from '../services/templateService.js'
import {
  createCampaign, sendCampaign, listCampaigns, resolveAudience, estimateCost
} from '../services/campaignService.js'

export const broadcastRouter = Router()
const bid = req => req.headers['x-business-id']

// ── Templates ─────────────────────────────────────────
broadcastRouter.get('/templates', async (req, res) => {
  const business = await getBusinessById(bid(req))
  if (!business) return res.status(404).json({ error: 'Business not found' })
  // Sync from Meta first (import new + update statuses), then return everything
  await refreshTemplateStatuses(business)
  const templates = await listTemplates(business.id)
  res.json(templates)
})

broadcastRouter.post('/templates', async (req, res) => {
  const business = await getBusinessById(bid(req))
  if (!business) return res.status(404).json({ error: 'Business not found' })
  const { template, error } = await createTemplate(business, req.body)
  if (error) return res.status(400).json({ error: error.message })
  res.status(201).json(template)
})

broadcastRouter.delete('/templates/:id', async (req, res) => {
  const business = await getBusinessById(bid(req))
  if (!business) return res.status(404).json({ error: 'Business not found' })
  const { error } = await deleteTemplate(business, req.params.id)
  if (error) return res.status(400).json({ error })
  res.json({ success: true })
})

// ── Audience preview (count + cost before sending) ────
broadcastRouter.get('/audience', async (req, res) => {
  const { segment = 'all', value } = req.query
  const audience = await resolveAudience(bid(req), segment, value)
  res.json({ count: audience.length, estCost: estimateCost(audience.length) })
})

// ── Campaigns ─────────────────────────────────────────
broadcastRouter.get('/campaigns', async (req, res) => {
  const campaigns = await listCampaigns(bid(req))
  res.json(campaigns)
})

broadcastRouter.post('/campaigns', async (req, res) => {
  const { campaign, audienceCount, error } = await createCampaign(bid(req), req.body)
  if (error) return res.status(400).json({ error: error.message })
  res.status(201).json({ ...campaign, audienceCount })
})

broadcastRouter.post('/campaigns/:id/send', async (req, res) => {
  const business = await getBusinessById(bid(req))
  if (!business) return res.status(404).json({ error: 'Business not found' })
  try {
    const result = await sendCampaign(business, req.params.id)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})