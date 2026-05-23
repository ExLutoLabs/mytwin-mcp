// GET /api/gifs — return published feature GIFs ordered by display_order
import { getDB } from '../lib/supabase.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')

  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'GET')    { return res.status(405).json({ error: 'Method not allowed' }) }

  const supabase = getDB()
  const { data, error } = await supabase
    .from('feature_gifs')
    .select('slug, title, caption, category, gif_url, display_order')
    .eq('status', 'published')
    .order('display_order', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })

  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  res.status(200).json(data)
}
