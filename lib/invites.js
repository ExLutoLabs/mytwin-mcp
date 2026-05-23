// Invite-and-redemption helpers for the prelaunch cohort.
//
// Model:
//   * One seed invite per envelope you hand out (admin generates ~50).
//   * Each successful redemption mints exactly one NEW invite for the
//     redeemer to pass on (per the "one person to bring in" rule).
//   * Cap = MAX_REDEMPTIONS total successful redemptions. After that the
//     prelaunch page swaps to a waitlist form.
//
// Codes use a Crockford-style alphabet without 0/O/1/I/L to stay readable
// when handed out by voice/copy. 8 chars × 32 alphabet → 32^8 ≈ 1.1T codes.

import { randomBytes } from 'node:crypto';
import { getDB } from './supabase.js';

const ALPHABET        = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH     = 8;
export const MAX_REDEMPTIONS = 50;

export function generateInviteCode(len = CODE_LENGTH) {
  const bytes = randomBytes(len);
  let code = '';
  for (let i = 0; i < len; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

// Seed N invites (no generated_by_user_id — these are admin-issued).
// Returns the codes that were inserted. Idempotent on code collision via
// .insert with unique constraint — collisions are vanishingly rare but we
// loop a few times to make it robust.
export async function seedInvites(n) {
  const db    = getDB();
  const codes = [];
  for (let i = 0; i < n; i++) {
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const code = generateInviteCode();
      const { error } = await db.from('invites').insert({ code });
      if (!error) {
        codes.push(code);
        inserted = true;
        break;
      }
      // 23505 = unique_violation — retry with a fresh code
      if (error.code !== '23505') {
        throw new Error(`Failed to seed invite: ${error.message}`);
      }
    }
    if (!inserted) throw new Error('Could not generate a unique invite code after 5 attempts');
  }
  return codes;
}

// Marks the invite as visited (bumps visit_count, sets first_visited_at if
// this is the first visit) and returns the current state. Used by the
// prelaunch page to decide what to render.
export async function checkInvite(code) {
  if (typeof code !== 'string' || !code.trim()) return { valid: false, reason: 'no_code' };
  const db = getDB();

  const { data, error } = await db.rpc('mark_invite_visited', { p_code: code });
  if (error) {
    console.error('[invites] mark_invite_visited failed:', error.message);
    return { valid: false, reason: 'lookup_failed' };
  }
  // RPC returns table — Supabase returns an array
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { valid: false, reason: 'not_found' };

  const cap = await capacityStatus();
  return {
    valid:       true,
    redeemed:    !!row.redeemed_by_user_id,
    visit_count: row.visit_count,
    cap_reached: cap.cap_reached,
    spots_left:  cap.spots_left,
    redemptions_total: cap.redemptions_total,
  };
}

// Aggregate capacity — count of redemptions across all invites.
export async function capacityStatus() {
  const db = getDB();
  const { count, error } = await db.from('invites')
    .select('id', { count: 'exact', head: true })
    .not('redeemed_by_user_id', 'is', null);
  if (error) {
    console.error('[invites] capacityStatus failed:', error.message);
    // Fail safe — don't pretend we have spots when we can't tell
    return { redemptions_total: MAX_REDEMPTIONS, spots_left: 0, cap_reached: true };
  }
  const redemptionsTotal = count || 0;
  const spotsLeft        = Math.max(0, MAX_REDEMPTIONS - redemptionsTotal);
  return {
    redemptions_total: redemptionsTotal,
    spots_left:        spotsLeft,
    cap_reached:       spotsLeft === 0,
  };
}

// Atomic redemption + mint of the next invite. Called from getOrCreateUser
// when a brand-new user is created via an invited magic-link flow.
//   * If the invite doesn't exist or is already redeemed → throws.
//   * If cap is reached → throws.
//   * Otherwise: stamps invite.redeemed_by_user_id + redeemed_at, mints
//     exactly one new invite for the new user, returns the new code.
export async function redeemInviteForNewUser({ code, userId }) {
  const db = getDB();

  // Refresh cap right before the mutation — small race window but acceptable
  // for prelaunch scale (one admin, few-per-day signups).
  const cap = await capacityStatus();
  if (cap.cap_reached) throw new Error('MyAITwin is at capacity. Join the waitlist.');

  // Mark this invite redeemed. Only succeeds if it's still unredeemed —
  // race-proof via the WHERE clause + unique index on redeemed_by_user_id.
  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await db.from('invites')
    .update({ redeemed_by_user_id: userId, redeemed_at: nowIso })
    .eq('code', code)
    .is('redeemed_by_user_id', null)
    .select('id')
    .maybeSingle();
  if (updErr) throw new Error(`Could not redeem invite: ${updErr.message}`);
  if (!updated) throw new Error('Invite is no longer valid (already redeemed or unknown).');

  // Mint exactly one new invite for the new user to pass on.
  let mintedCode = null;
  for (let attempt = 0; attempt < 5 && !mintedCode; attempt++) {
    const c = generateInviteCode();
    const { error: insErr } = await db.from('invites')
      .insert({ code: c, generated_by_user_id: userId });
    if (!insErr) { mintedCode = c; break; }
    if (insErr.code !== '23505') {
      console.error('[invites] mint failed:', insErr.message);
      break;
    }
  }
  return { redeemed_code: code, minted_code: mintedCode };
}

// Look up the invite a given user can share — the one minted to them on
// redemption. Returns null for pre-existing users (no invite minted to them).
export async function getUserOutboundInvite(userId) {
  const db = getDB();
  const { data } = await db.from('invites')
    .select('code, redeemed_by_user_id, redeemed_at, visit_count, first_visited_at, created_at')
    .eq('generated_by_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;

  // If their invite has been redeemed, also surface who took it (email).
  let redeemed_by_email = null;
  if (data.redeemed_by_user_id) {
    const { data: u } = await db.from('users').select('email').eq('id', data.redeemed_by_user_id).maybeSingle();
    redeemed_by_email = u?.email || null;
  }

  return {
    code:               data.code,
    redeemed:           !!data.redeemed_by_user_id,
    redeemed_by_email,
    redeemed_at:        data.redeemed_at,
    visit_count:        data.visit_count,
    first_visited_at:   data.first_visited_at,
    created_at:         data.created_at,
  };
}
