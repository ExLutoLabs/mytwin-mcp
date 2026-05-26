// POST /api/auth/request — send magic link email
import { Resend } from 'resend';
import { createMagicToken } from '../../lib/auth.js';
import { checkRateLimit, RATE_LIMITS } from '../../lib/rate-limit.js';
import { logAudit } from '../../lib/audit.js';

// Per security brief item 13: every code path returns the same response
// after the same minimum duration. Prevents user-enumeration timing attacks
// and never reveals whether an email is registered or what failed.
const GENERIC_REQUEST_RESPONSE = { ok: true };
const MIN_RESPONSE_MS = 800;

export default async function handler(req, res) {
  const APP_URL = process.env.APP_URL || 'https://myaitwin.lutolearn.com';
  const FROM    = process.env.RESEND_FROM || 'team@lutolearn.com';
  const resend  = new Resend(process.env.RESEND_API_KEY);

  res.setHeader('Access-Control-Allow-Origin',  APP_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const startedAt = Date.now();

  try {
    const { email } = req.body || {};

    // Single fail-closed validation: bad email shape skips the send but still
    // pads the response. Caller can't distinguish bad-email from
    // good-email-send-failed from good-email-success.
    if (email && isValidEmail(email)) {
      const cleaned = email.toLowerCase().trim();

      // Per-email rate limit (5/hour). On exceeded we silently drop the
      // send — no error to the caller, no timing variation. An abuser can't
      // tell whether they're rate-limited vs whether the email is invalid
      // vs whether the send just worked. (Item 13 preserved.)
      const rl = await checkRateLimit(`auth:${cleaned}`, RATE_LIMITS.AUTH_PER_HOUR);
      if (!rl.exceeded) {
        let sendOk = true;
        try {
          const token    = await createMagicToken(cleaned);
          const magicUrl = `${APP_URL}/api/auth/verify?token=${token}`;

          await resend.emails.send({
            from:    FROM,
            to:      email,
            subject: 'Sign in to MyAITwin MCP',
            html:    buildEmailHtml(magicUrl),
            text:    buildEmailText(magicUrl),
          });
        } catch (err) {
          sendOk = false;
          // Log internally — never surface to caller. Identical response either way.
          console.error('auth/request internal error:', err && err.message);
        }
        // Audit event — no email is recorded; only outcome.
        logAudit({
          eventType: 'magic_link_requested',
          success:   sendOk,
          errorType: sendOk ? null : 'EmailSendFailed',
        });
      } else {
        console.warn(`[auth/request] rate-limited (silently dropped) — email hash bucket: auth:${cleaned.slice(0, 3)}…`);
        logAudit({
          eventType: 'magic_link_requested',
          success:   false,
          errorType: 'RateLimited',
        });
      }
    }
  } finally {
    // Pad to a uniform floor so every response takes ~the same wall time.
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_RESPONSE_MS) {
      await new Promise(r => setTimeout(r, MIN_RESPONSE_MS - elapsed));
    }
    res.status(200).json(GENERIC_REQUEST_RESPONSE);
  }
}

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

function buildEmailHtml(url) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FDFCFA;margin:0;padding:0">

  <div style="height:6px;background:#FFE34A;width:100%"></div>

  <div style="max-width:520px;margin:0 auto;padding:48px 32px 56px">

    <div style="display:flex;align-items:center;gap:10px;margin-bottom:48px">
      <div style="width:24px;height:24px;background:#FFE34A;border:1.5px solid #0F0E0D;border-radius:4px;box-shadow:2px 2px 0 #0F0E0D;flex-shrink:0"></div>
      <span style="font-size:15px;font-weight:600;color:#0F0E0D;letter-spacing:-0.01em">MyAITwin MCP</span>
      <span style="font-size:10px;color:#857C6E;letter-spacing:0.1em;text-transform:uppercase;font-family:monospace;margin-left:2px">by Luto</span>
    </div>

    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#0F0E0D;margin:0 0 16px;line-height:1.15;letter-spacing:-0.02em">
      Your Twin is ready.
    </h1>
    <p style="font-size:15px;color:#3A352E;line-height:1.6;margin:0 0 36px">
      Click below to sign in. This link expires in 15 minutes and works once.
    </p>

    <a href="${url}" style="display:inline-block;background:#FFE34A;color:#0F0E0D;text-decoration:none;padding:14px 28px;border-radius:8px;border:1.5px solid #0F0E0D;box-shadow:3px 3px 0 #0F0E0D;font-size:15px;font-weight:600;letter-spacing:-0.01em">
      Open my Twin &rarr;
    </a>

    <div style="height:1px;background:#E8E2D4;margin:48px 0 32px"></div>

    <p style="font-size:12px;color:#857C6E;line-height:1.7;margin:0;font-family:monospace;letter-spacing:0.02em">
      myaitwin.lutolearn.com &nbsp;&middot;&nbsp; No password needed &nbsp;&middot;&nbsp; Link expires in 15 minutes<br>
      If you did not request this, ignore this email. Nothing will happen.
    </p>
    <p style="font-size:11px;color:#B6AD9C;margin:16px 0 0;font-family:monospace;word-break:break-all">
      ${url}
    </p>

  </div>
</body>
</html>`;
}

function buildEmailText(url) {
  return `MyAITwin MCP by Luto\n\nYour Twin is ready.\n\nClick the link below to sign in. This link expires in 15 minutes and works once.\n\n${url}\n\nIf you did not request this, ignore this email. Nothing will happen.`;
}
