// POST /api/invites/redeem
// Body: { code, email }
//
// Validates the code + capacity, then kicks off the magic-link flow with the
// invite_code embedded in the magic_tokens row. When the user clicks the
// magic link, the verify endpoint creates the user AND atomically redeems
// the invite + mints a new outbound invite for them.
//
// Uses the same timing floor as /api/auth/request (per security brief
// item 13) so we never reveal whether the email is already a user.

import { Resend } from 'resend';
import { createMagicToken } from '../../lib/auth.js';
import { checkInvite, capacityStatus } from '../../lib/invites.js';
import { checkRateLimit, RATE_LIMITS } from '../../lib/rate-limit.js';
import { logAudit } from '../../lib/audit.js';

const MIN_RESPONSE_MS = 800;

export default async function handler(req, res) {
  const APP_URL = process.env.APP_URL || 'https://myaitwin.lutolearn.com';
  const FROM    = process.env.RESEND_FROM || 'team@lutolearn.com';
  const resend  = new Resend(process.env.RESEND_API_KEY);

  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'POST only' }); }

  const startedAt = Date.now();
  let result = { ok: false, reason: 'unknown' };

  try {
    const body  = req.body || {};
    const code  = String(body.code  || '').trim().toUpperCase();
    const email = String(body.email || '').trim();

    if (!code) {
      result = { ok: false, reason: 'no_code' };
    } else if (!isValidEmail(email)) {
      result = { ok: false, reason: 'invalid_email' };
    } else {
      // Capacity gate before we even look up the code — saves DB work and
      // returns the cleanest "we're full" message.
      const cap = await capacityStatus();
      if (cap.cap_reached) {
        result = { ok: false, reason: 'at_capacity', spots_left: 0 };
      } else {
        // Validate code shape + redemption state
        const state = await checkInvite(code);
        if (!state.valid)       result = { ok: false, reason: 'invalid_code' };
        else if (state.redeemed) result = { ok: false, reason: 'already_redeemed' };
        else if (state.cap_reached) result = { ok: false, reason: 'at_capacity' };
        else {
          // Per-email rate limit (5/hour) — same shape as /api/auth/request
          const cleaned = email.toLowerCase();
          const rl = await checkRateLimit(`auth:${cleaned}`, RATE_LIMITS.AUTH_PER_HOUR);
          if (!rl.exceeded) {
            try {
              const token    = await createMagicToken(cleaned, code);
              const magicUrl = `${APP_URL}/api/auth/verify?token=${token}`;
              await resend.emails.send({
                from:    FROM,
                to:      email,
                subject: 'Welcome to MyAITwin — your magic link',
                html:    buildEmailHtml(magicUrl, code),
                text:    buildEmailText(magicUrl, code),
              });
              logAudit({ eventType: 'invite_redeem_requested', success: true, context: { code_prefix: code.slice(0, 4) } });
              result = { ok: true };
            } catch (err) {
              console.error('[invites/redeem] send failed:', err && err.message);
              logAudit({ eventType: 'invite_redeem_requested', success: false, errorType: 'EmailSendFailed' });
              result = { ok: false, reason: 'send_failed' };
            }
          } else {
            logAudit({ eventType: 'invite_redeem_requested', success: false, errorType: 'RateLimited' });
            // Silent on rate-limit — uniform shape, no enumeration
            result = { ok: true };
          }
        }
      }
    }
  } finally {
    // Pad to MIN_RESPONSE_MS so timing doesn't leak which branch we took.
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_RESPONSE_MS) {
      await new Promise(r => setTimeout(r, MIN_RESPONSE_MS - elapsed));
    }
    res.status(200).json(result);
  }
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function buildEmailHtml(url, code) {
  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FDFCFA;margin:0;padding:0">
  <div style="height:6px;background:#FFE34A;width:100%"></div>
  <div style="max-width:520px;margin:0 auto;padding:48px 32px 56px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:36px">
      <div style="width:24px;height:24px;background:#FFE34A;border:1.5px solid #0F0E0D;border-radius:4px;box-shadow:2px 2px 0 #0F0E0D"></div>
      <span style="font-size:15px;font-weight:600;color:#0F0E0D">MyAITwin MCP</span>
      <span style="font-size:10px;color:#857C6E;letter-spacing:0.1em;text-transform:uppercase;font-family:monospace">by Luto</span>
    </div>
    <h1 style="font-family:Georgia,serif;font-size:28px;font-weight:400;color:#0F0E0D;margin:0 0 14px;line-height:1.15;letter-spacing:-0.02em">You're in.</h1>
    <p style="font-size:15px;color:#3A352E;line-height:1.6;margin:0 0 28px">Your invite <strong>${code}</strong> got you in. Click below to set up your Twin. This link expires in 15 minutes and works once.</p>
    <a href="${url}" style="display:inline-block;background:#FFE34A;color:#0F0E0D;text-decoration:none;padding:14px 28px;border-radius:8px;border:1.5px solid #0F0E0D;box-shadow:3px 3px 0 #0F0E0D;font-size:15px;font-weight:600">Set up my Twin &rarr;</a>
    <div style="height:1px;background:#E8E2D4;margin:40px 0 24px"></div>
    <p style="font-size:12px;color:#857C6E;line-height:1.7;margin:0;font-family:monospace">myaitwin.lutolearn.com &middot; No password needed &middot; Link expires in 15 minutes<br>If you did not request this, ignore this email. Nothing will happen.</p>
  </div>
</body></html>`;
}

function buildEmailText(url, code) {
  return `MyAITwin MCP — by Luto\n\nYou're in.\n\nYour invite ${code} got you in. Click the link to set up your Twin. This link expires in 15 minutes.\n\n${url}\n\nIf you did not request this, ignore this email.`;
}
