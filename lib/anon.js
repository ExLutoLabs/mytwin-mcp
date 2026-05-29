// Anonymous tenants for the /twin web mini-interface.
//
// Model:
//   * `/api/anon/init` provisions an anonymous tenant + placeholder user row
//     (email `anon+<tenant_id>@mytwin.local`) + default schema types.
//   * Returns a signed JWT (`mt_anon` token) that the frontend stores in
//     localStorage and presents on every subsequent request via the
//     `X-Anon-Token` header.
//   * `requireTenant(req)` resolves a `{ userId, tenantId, isAnonymous }`
//     context from EITHER an authenticated session cookie OR an anon token.
//
// Why a JWT, not the raw tenant_id?
//   The tenant_id alone is not authenticating data — anyone who guesses or
//   sees another tenant's id could impersonate it. The JWT is signed with
//   JWT_SECRET (same secret as the magic-link session cookie), so the server
//   verifies authenticity without a DB round-trip per request.

import { SignJWT, jwtVerify } from 'jose';
import { getDB } from './supabase.js';
import { requireAuth } from './auth.js';

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET env var is required.');
}
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

// Long-lived; anonymous tenants are meant to persist until the user clears
// localStorage or signs up. One year matches the practical expectation.
const ANON_TOKEN_EXPIRY = '365d';

// Mirrors lib/auth.js DEFAULT_SCHEMA_TYPES — kept in sync deliberately. We
// don't import the constant because it's not exported there and pulling it
// out as a shared constant would touch unrelated code.
const DEFAULT_SCHEMA_TYPES = [
  { name: 'voice',     description: 'Writing style, tone, how you communicate' },
  { name: 'brand',     description: 'Visual preferences, aesthetic principles, brand rules' },
  { name: 'knowledge', description: 'Expertise areas, domain knowledge, what you know deeply' },
  { name: 'skill',     description: 'Methods, frameworks, how you do specific things' },
  { name: 'template',  description: 'Reusable structures, formats, scaffolding' },
  { name: 'idea',      description: 'Concepts, hypotheses, things you\'re exploring' },
  { name: 'resource',  description: 'Links, documents, references you trust' },
  { name: 'principle', description: 'Repeating values, rules, guidelines you apply consistently' },
];

// ── Anon JWT helpers ──────────────────────────────────────────────────────────

export async function createAnonToken({ tenantId, userId }) {
  return new SignJWT({ tenantId, userId, kind: 'anon' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ANON_TOKEN_EXPIRY)
    .sign(JWT_SECRET);
}

export async function verifyAnonToken(token) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if (payload.kind !== 'anon') return null;
    if (!payload.tenantId || !payload.userId) return null;
    return { tenantId: payload.tenantId, userId: payload.userId };
  } catch {
    return null;
  }
}

function getAnonTokenFromRequest(req) {
  const header = req.headers['x-anon-token'];
  if (typeof header === 'string' && header) return header;
  return null;
}

// ── Provision an anonymous tenant ─────────────────────────────────────────────

export async function createAnonymousTenant() {
  const db = getDB();

  // 1. Tenant row marked anonymous.
  const { data: tenant, error: tenantErr } = await db
    .from('tenants')
    .insert({ is_anonymous: true, anon_created_at: new Date().toISOString() })
    .select('id')
    .single();
  if (tenantErr) throw new Error(`tenant insert: ${tenantErr.message}`);

  // 2. Placeholder user row — keeps users.tenant_id NOT NULL contract intact
  //    so every existing query path (user_id + tenant_id filtered) keeps
  //    working unchanged when this tenant calls the tools.
  const placeholderEmail = `anon+${tenant.id}@mytwin.local`;
  const { data: user, error: userErr } = await db
    .from('users')
    .insert({ email: placeholderEmail, tenant_id: tenant.id })
    .select('id')
    .single();
  if (userErr) throw new Error(`user insert: ${userErr.message}`);

  // 3. Seed default schema types so the twin starts with the standard
  //    voice/skill/knowledge/idea/etc. surface — matches the post-signup
  //    experience exactly.
  await db.from('schema_types').insert(
    DEFAULT_SCHEMA_TYPES.map(t => ({ ...t, user_id: user.id, tenant_id: tenant.id }))
  );

  return { tenantId: tenant.id, userId: user.id };
}

// ── Request → tenant context ─────────────────────────────────────────────────

/**
 * Resolve the active tenant for a request, in this order:
 *   1. Session cookie (authenticated user)  — looks up tenant_id from users.
 *   2. X-Anon-Token header (anonymous)      — verifies JWT, no DB hit.
 *   3. null                                 — caller should return 401.
 *
 * @returns {Promise<{ userId: string, tenantId: string, isAnonymous: boolean } | null>}
 */
export async function requireTenant(req) {
  // Authenticated session takes precedence — once a user signs in we never
  // honour an anon token on the same request.
  const session = await requireAuth(req);
  if (session) {
    const db = getDB();
    const { data: user } = await db
      .from('users')
      .select('tenant_id')
      .eq('id', session.userId)
      .maybeSingle();
    if (!user) return null;
    return { userId: session.userId, tenantId: user.tenant_id, isAnonymous: false };
  }

  const anonToken = getAnonTokenFromRequest(req);
  if (anonToken) {
    const payload = await verifyAnonToken(anonToken);
    if (payload) {
      return { userId: payload.userId, tenantId: payload.tenantId, isAnonymous: true };
    }
  }

  return null;
}
