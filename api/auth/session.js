// GET /api/auth/session — validate the current session cookie.
//
// Called on every /twin page load to hydrate localStorage with the
// authenticated user's email and flag, so the header shows the right state.
//
// Returns:
//   { valid: true, is_authenticated: true, email, user_id, tenant_id }  — signed-in user
//   { valid: false, is_authenticated: false }                            — no session / expired

import { requireAuth } from '../../lib/auth.js';
import { getDB }       from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).end(); return; }
  res.setHeader('Cache-Control', 'no-store, no-cache');

  try {
    const session = await requireAuth(req);
    if (!session) {
      return res.status(200).json({ valid: false, is_authenticated: false });
    }

    const db = getDB();
    const { data: user } = await db
      .from('users')
      .select('email, tenant_id, created_at')
      .eq('id', session.userId)
      .maybeSingle();

    if (!user) {
      return res.status(200).json({ valid: false, is_authenticated: false });
    }

    return res.status(200).json({
      valid:            true,
      is_authenticated: true,
      email:            user.email,
      user_id:          session.userId,
      tenant_id:        user.tenant_id,
    });
  } catch (err) {
    console.error('[auth/session]', err?.message);
    return res.status(200).json({ valid: false, is_authenticated: false });
  }
}
