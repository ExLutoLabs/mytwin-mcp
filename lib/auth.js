import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { getDB } from './supabase.js';
import { redeemInviteForNewUser } from './invites.js';

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET env var is required. Generate with: openssl rand -base64 32');
}
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

const TOKEN_EXPIRY_MINUTES = 15;
const SESSION_EXPIRY_DAYS  = 30;

// ── Magic link ─────────────────────────────────────────────────────────────────

export async function createMagicToken(email, inviteCode = null) {
  const db = getDB();
  const token = crypto.randomUUID() + '-' + crypto.randomUUID();
  const expires_at = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const row = { email, token, expires_at };
  if (inviteCode) row.invite_code = inviteCode;

  const { error } = await db.from('magic_tokens').insert(row);
  if (error) throw new Error(error.message);

  return token;
}

export async function verifyMagicToken(token) {
  const db = getDB();
  const now = new Date().toISOString();

  // Atomic single-use: one UPDATE that only succeeds if the token exists,
  // is unused, AND is still within its expiry window. Race-condition proof —
  // two concurrent verifies of the same token can't both win, because the
  // database serialises the row update. We deliberately collapse "not found",
  // "already used", and "expired" into one unified error (per security brief
  // item 13: auth errors must not leak which sub-state failed).
  const { data, error } = await db
    .from('magic_tokens')
    .update({ used: true })
    .eq('token', token)
    .eq('used', false)
    .gte('expires_at', now)
    .select()
    .single();

  if (error || !data) {
    throw new Error('Invalid or expired link.');
  }

  // Return both email and (optional) invite_code so the verify endpoint can
  // pass the code through to getOrCreateUser for redemption + mint.
  return { email: data.email, inviteCode: data.invite_code || null };
}

// ── User provisioning ──────────────────────────────────────────────────────────

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

export async function getOrCreateUser(email, opts = {}) {
  const db = getDB();
  const { inviteCode = null, allowUninvited = false } = opts;

  // Try to find existing user — returning users sign in regardless of invite.
  const { data: existing } = await db.from('users').select('*').eq('email', email).maybeSingle();
  if (existing) return { user: existing, isNew: false };

  // Prelaunch gate: new users must come through the invite flow OR be
  // explicitly allowed (cross-tenant test suite passes allowUninvited: true).
  if (!inviteCode && !allowUninvited) {
    throw new Error('Signup is invite-only right now. Use an invite link or join the waitlist.');
  }

  // New user — create a tenant first (1:1 with the user for MVP), then the
  // user with its tenant_id set, then seed default schema types.
  const { data: tenant, error: tenantErr } = await db
    .from('tenants')
    .insert({})
    .select('id')
    .single();
  if (tenantErr) throw new Error(tenantErr.message);

  const { data: user, error: userErr } = await db
    .from('users')
    .insert({ email, tenant_id: tenant.id })
    .select()
    .single();
  if (userErr) throw new Error(userErr.message);

  // Seed default schema types — also stamped with tenant_id.
  await db.from('schema_types').insert(
    DEFAULT_SCHEMA_TYPES.map(t => ({ ...t, user_id: user.id, tenant_id: tenant.id }))
  );

  // Redeem the invite + mint a new outbound invite for this user. If the
  // invite is no longer valid (race, cap reached) we surface a clear error
  // — the caller (verify endpoint) can flash it to the user.
  let mintedInviteCode = null;
  if (inviteCode) {
    const result = await redeemInviteForNewUser({ code: inviteCode, userId: user.id });
    mintedInviteCode = result.minted_code || null;
  }

  return { user, isNew: true, mintedInviteCode };
}

// ── JWT session ────────────────────────────────────────────────────────────────

export async function createSessionToken(userId, email) {
  return new SignJWT({ userId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_EXPIRY_DAYS}d`)
    .sign(JWT_SECRET);
}

export async function verifySessionToken(token) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return { userId: payload.userId, email: payload.email };
  } catch {
    return null;
  }
}

// ── Cookie helpers ─────────────────────────────────────────────────────────────

export function getSessionCookie(req) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)mt_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setSessionCookie(res, token) {
  const maxAge = SESSION_EXPIRY_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie', [
    `mt_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  ]);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [
    'mt_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
  ]);
}

// ── Request auth middleware ────────────────────────────────────────────────────

export async function requireAuth(req) {
  const cookie = getSessionCookie(req);
  if (!cookie) return null;
  return verifySessionToken(cookie);
}

// ── MCP bearer tokens ──────────────────────────────────────────────────────────
//
// Tokens are issued once per user and used to authenticate every MCP request.
// We store SHA-256 hashes only; the raw value is returned to the user exactly
// once (on first issue or after regenerate) and never again.
//
// One active token per user (enforced by the partial unique index on
// mcp_tokens). Regenerate revokes the previous and mints a new one.

const MCP_TOKEN_PREFIX = 'mt_';

function generateMcpToken() {
  const raw    = randomBytes(32).toString('hex'); // 64 hex chars
  const token  = MCP_TOKEN_PREFIX + raw;          // 'mt_' + 64 hex = 67 chars
  const hash   = createHash('sha256').update(token).digest('hex');
  const prefix = token.slice(0, 11);              // 'mt_' + 8 hex chars — safe to show in UI
  return { token, hash, prefix };
}

function hashMcpToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Mint a new token for the user. Revokes the previous active one (if any)
// so the partial unique index isn't violated.
export async function mintMcpTokenForUser(userId) {
  const db = getDB();

  const { data: user, error: userErr } = await db
    .from('users')
    .select('tenant_id')
    .eq('id', userId)
    .single();
  if (userErr || !user) throw new Error('User not found');

  const nowIso = new Date().toISOString();

  // Revoke any existing active token (idempotent — no-op if none)
  await db.from('mcp_tokens')
    .update({ revoked_at: nowIso })
    .eq('user_id', userId)
    .is('revoked_at', null);

  // Mint and insert the new one
  const { token, hash, prefix } = generateMcpToken();
  const { data, error } = await db.from('mcp_tokens')
    .insert({ user_id: userId, tenant_id: user.tenant_id, token_hash: hash, token_prefix: prefix })
    .select('token_prefix, created_at')
    .single();
  if (error) throw new Error(error.message);

  return { token, prefix: data.token_prefix, createdAt: data.created_at };
}

// Look up the active token's display info — never returns the raw value
// (we can't; we only stored the hash).
export async function getActiveMcpTokenInfo(userId) {
  const db = getDB();
  const { data } = await db.from('mcp_tokens')
    .select('token_prefix, created_at, last_used_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .maybeSingle();
  if (!data) return null;
  return { prefix: data.token_prefix, createdAt: data.created_at, lastUsedAt: data.last_used_at };
}

// Verify a presented token. Returns { userId, tenantId } on success, null on
// any failure. Fire-and-forget bumps last_used_at; we don't block the request.
export async function verifyMcpToken(token) {
  if (!token || typeof token !== 'string' || !token.startsWith(MCP_TOKEN_PREFIX)) return null;
  const db   = getDB();
  const hash = hashMcpToken(token);

  const { data } = await db.from('mcp_tokens')
    .select('user_id, tenant_id')
    .eq('token_hash', hash)
    .is('revoked_at', null)
    .maybeSingle();
  if (!data) return null;

  // Bump last_used_at — best effort, never blocks
  db.from('mcp_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('token_hash', hash)
    .is('revoked_at', null)
    .then(() => {}, () => {});

  return { userId: data.user_id, tenantId: data.tenant_id };
}
