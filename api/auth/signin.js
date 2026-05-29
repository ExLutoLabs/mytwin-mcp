// POST /api/auth/signin — send a magic link to a returning user.
//
// Body:  { email: string }
// Returns { sent: true } regardless of outcome (no user enumeration).
// Rate limit: 5 requests per email per hour.
//
// Separate from /api/auth/claim which handles the anonymous → real-account
// upgrade path (requires tenant_id). This endpoint is for users who already
// have an account and just want to sign back in.

import { Resend }          from 'resend';
import { createMagicToken } from '../../lib/auth.js';
import { checkRateLimit, RATE_LIMITS } from '../../lib/rate-limit.js';
import { logAudit }        from '../../lib/audit.js';

const MIN_RESPONSE_MS = 800;

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

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

    if (email && isValidEmail(email)) {
      const cleaned = email.toLowerCase().trim();
      const rl = await checkRateLimit(`signin:${cleaned}`, RATE_LIMITS.AUTH_PER_HOUR);

      if (!rl.exceeded) {
        let sendOk = true;
        try {
          const token    = await createMagicToken(cleaned);
          const magicUrl = `${APP_URL}/api/auth/verify?token=${token}`;

          await resend.emails.send({
            from:    FROM,
            to:      email,
            subject: 'Sign in to your twin',
            html:    buildSigninEmailHtml(magicUrl),
            text:    buildSigninEmailText(magicUrl),
          });
        } catch (err) {
          sendOk = false;
          console.error('[auth/signin] error:', err?.message);
        }
        logAudit({
          eventType: 'signin_magic_link_requested',
          success:   sendOk,
          errorType: sendOk ? null : 'EmailSendFailed',
        });
      } else {
        logAudit({ eventType: 'signin_magic_link_requested', success: false, errorType: 'RateLimited' });
      }
    }
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_RESPONSE_MS) await new Promise(r => setTimeout(r, MIN_RESPONSE_MS - elapsed));
    res.status(200).json({ sent: true });
  }
}

function buildSigninEmailHtml(url) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FDFCFA;margin:0;padding:0">

  <div style="height:6px;background:#FFE34A;width:100%"></div>

  <div style="max-width:520px;margin:0 auto;padding:48px 32px 56px">

    <div style="display:flex;align-items:center;gap:10px;margin-bottom:48px">
      <div style="width:24px;height:24px;background:#FFE34A;border:1.5px solid #0F0E0D;border-radius:4px;box-shadow:2px 2px 0 #0F0E0D;flex-shrink:0"></div>
      <span style="font-size:15px;font-weight:600;color:#0F0E0D;letter-spacing:-0.01em">MyAITwin</span>
      <span style="font-size:10px;color:#857C6E;letter-spacing:0.1em;text-transform:uppercase;font-family:monospace;margin-left:2px">by Luto</span>
    </div>

    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#0F0E0D;margin:0 0 16px;line-height:1.15;letter-spacing:-0.02em">
      Welcome back.
    </h1>
    <p style="font-size:15px;color:#3A352E;line-height:1.6;margin:0 0 36px">
      Here's your link to get back in. It expires in 15 minutes and can only be used once.
    </p>

    <a href="${url}" style="display:inline-block;background:#FFE34A;color:#0F0E0D;text-decoration:none;padding:14px 28px;border-radius:8px;border:1.5px solid #0F0E0D;box-shadow:3px 3px 0 #0F0E0D;font-size:15px;font-weight:600;letter-spacing:-0.01em">
      Sign in &rarr;
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

function buildSigninEmailText(url) {
  return `MyAITwin by Luto\n\nWelcome back.\n\nHere's your link to get back in:\n\n${url}\n\nThis link expires in 15 minutes and can only be used once.\n\nIf you did not request this, ignore this email. Nothing will happen.`;
}
