import { Router } from 'express'
import { supabase } from '../config/database.js'
export const authRouter = Router()
authRouter.get('/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token' })
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Invalid token' })
  res.json({ user })
})
