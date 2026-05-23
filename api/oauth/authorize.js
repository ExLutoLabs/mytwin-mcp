// GET  /api/oauth/authorize  — show email login page for the client
// POST /api/oauth/authorize  — accept email, send magic link, show "check your inbox"
//
// OAuth params (response_type=code, client_id, redirect_uri, state, scope)
// are passed in the URL and round-trip through the magic link by being
// stored on the magic_tokens row so /api/oauth/callback can recover them.

import { Resend } from 'resend';
import { createMagicToken } from '../../lib/auth.js';
import { getClient, isRedirectUriAllowed, buildRedirect } from '../../lib/oauth.js';
import { getDB } from '../../lib/supabase.js';
import { checkRateLimit, RATE_LIMITS } from '../../lib/rate-limit.js';
import { logAudit } from '../../lib/audit.js';

export const config = { maxDuration: 15 };

const APP_URL = process.env.APP_URL || 'https://myaitwin.lutolearn.com';
const FROM    = process.env.RESEND_FROM || 'team@lutolearn.com';

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function escape(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// Single-page login form. Posts back to itself with the OAuth params kept on
// hidden inputs so the round-trip works on basic browsers.
function renderLogin({ clientId, redirectUri, state, scope, clientName, error }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sign in — MyAITwin MCP</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,500&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #FDFCFA; color: #0F0E0D;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .bar { position: fixed; top: 0; left: 0; right: 0; height: 6px; background: #FFE34A; }
    .card { width: 100%; max-width: 420px; }
    .mark { width: 28px; height: 28px; background: #FFE34A; border: 1.5px solid #0F0E0D;
            border-radius: 4px; box-shadow: 2px 2px 0 #0F0E0D; margin-bottom: 18px; }
    .eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600;
               text-transform: uppercase; letter-spacing: 0.12em; color: #857C6E; margin-bottom: 6px; }
    h1 { font-family: 'Source Serif 4', Georgia, serif; font-size: 1.6rem; font-weight: 500;
         letter-spacing: -0.02em; margin-bottom: 10px; }
    p { font-size: 14px; color: #3A352E; line-height: 1.55; margin-bottom: 24px; }
    input[type=email] { width: 100%; padding: 14px 16px; border: 1.5px solid #0F0E0D;
      border-radius: 8px; background: #FDFCFA; font-family: 'JetBrains Mono', monospace;
      font-size: 14px; outline: none; box-shadow: 3px 3px 0 #0F0E0D; margin-bottom: 14px; }
    button { width: 100%; padding: 14px; background: #FFE34A; color: #0F0E0D;
      border: 1.5px solid #0F0E0D; border-radius: 8px; font-family: 'Inter', sans-serif;
      font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 3px 3px 0 #0F0E0D; }
    button:hover { transform: translate(2px, 2px); box-shadow: none; }
    .err { color: #FF5A3C; font-size: 12px; margin-top: 10px; min-height: 16px; }
    .muted { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #857C6E;
             margin-top: 24px; text-transform: uppercase; letter-spacing: 0.08em; }
  </style>
</head>
<body>
  <div class="bar"></div>
  <div class="card">
    <div class="mark" aria-hidden="true"></div>
    <div class="eyebrow">MyAITwin · OAuth sign-in</div>
    <h1>Connect ${escape(clientName || clientId)}</h1>
    <p>Enter the email on your MyAITwin account. We'll send you a magic link — clicking it connects your twin to <strong>${escape(clientName || clientId)}</strong>.</p>
    <form method="POST" action="/api/oauth/authorize">
      <input type="hidden" name="client_id"     value="${escape(clientId)}">
      <input type="hidden" name="redirect_uri"  value="${escape(redirectUri)}">
      <input type="hidden" name="state"         value="${escape(state || '')}">
      <input type="hidden" name="scope"         value="${escape(scope || '')}">
      <input type="email"  name="email"         placeholder="your@email.com" autocomplete="email" autofocus required>
      <button type="submit">Send magic link →</button>
      <div class="err">${error ? escape(error) : ''}</div>
    </form>
    <p class="muted">By signing in you agree to our <a href="/privacy" style="color:#857C6E;">privacy policy</a>.</p>
  </div>
</body>
</html>`;
}

function renderSent({ email }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Check your inbox — MyAITwin</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,500&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',system-ui,sans-serif;background:#FDFCFA;color:#0F0E0D;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.bar{position:fixed;top:0;left:0;right:0;height:6px;background:#FFE34A}.card{width:100%;max-width:420px;text-align:center}.mark{width:28px;height:28px;background:#FFE34A;border:1.5px solid #0F0E0D;border-radius:4px;box-shadow:2px 2px 0 #0F0E0D;margin:0 auto 18px}.eyebrow{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.12em;color:#857C6E;margin-bottom:6px}h1{font-family:'Source Serif 4',Georgia,serif;font-size:1.6rem;font-weight:500;letter-spacing:-0.02em;margin-bottom:10px}p{font-size:14px;color:#3A352E;line-height:1.55;margin-bottom:8px}.email{font-family:'JetBrains Mono',monospace;font-size:13px;color:#0F0E0D;background:#F9F8F4;border:1px solid #E8E2D4;padding:8px 12px;border-radius:6px;display:inline-block;margin-top:8px}</style></head><body><div class="bar"></div><div class="card"><div class="mark"></div><div class="eyebrow">MyAITwin · OAuth sign-in</div><h1>Check your inbox.</h1><p>If an account exists for that email, a magic link is on its way.</p><div class="email">${escape(email || '')}</div><p style="margin-top:18px;font-size:12px;color:#857C6E">You can close this tab. Claude Desktop will be connected automatically once you click the link.</p></div></body></html>`;
}

export default async function handler(req, res) {
  if (req.method === 'GET') return handleAuthorize(req, res);
  if (req.method === 'POST') return handleSubmit(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handleAuthorize(req, res) {
  const { client_id, redirect_uri, response_type, state, scope } = req.query || {};
  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported.' });
  }
  const client = await getClient(client_id);
  if (!client) {
    return res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id.' });
  }
  if (!isRedirectUriAllowed(client, redirect_uri)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is not registered for this client.' });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(renderLogin({
    clientId:    client.client_id,
    redirectUri: redirect_uri,
    state, scope,
    clientName:  client.name,
  }));
}

async function handleSubmit(req, res) {
  // Body may be url-encoded (HTML form) — Vercel parses application/x-www-form-urlencoded
  // into req.body when the content-type matches.
  const body = req.body || {};
  const client_id    = String(body.client_id    || '');
  const redirect_uri = String(body.redirect_uri || '');
  const state        = String(body.state        || '');
  const scope        = String(body.scope        || '');
  const email        = String(body.email        || '').trim().toLowerCase();

  const client = await getClient(client_id);
  if (!client || !isRedirectUriAllowed(client, redirect_uri)) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  // Rate limit per email — 10/hr per Section 8 spec (separate bucket from
  // regular auth requests).
  if (isValidEmail(email)) {
    const rl = await checkRateLimit(`oauth_authorize:${email}`, 10);
    if (rl.exceeded) {
      logAudit({ eventType: 'oauth_authorize_requested', success: false, errorType: 'RateLimited' });
      // Same generic confirmation either way — never reveal rate-limit state.
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(renderSent({ email }));
    }
  }

  let sendOk = false;
  if (isValidEmail(email)) {
    try {
      const token    = await createMagicToken(email);
      // Stash OAuth context on the magic_tokens row so /api/oauth/callback
      // can recover it after the click.
      const db = getDB();
      await db.from('magic_tokens')
        .update({
          oauth_client_id:    client.client_id,
          oauth_redirect_uri: redirect_uri,
          oauth_state:        state || null,
          oauth_scope:        scope || null,
        })
        .eq('token', token);

      const magicUrl = `${APP_URL}/api/oauth/callback?token=${encodeURIComponent(token)}`;
      const resend   = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:    FROM,
        to:      email,
        subject: `Connect ${client.name || client.client_id} to your twin`,
        html:    buildEmailHtml(magicUrl, client.name || client.client_id),
        text:    `Sign in to MyAITwin and connect ${client.name || client.client_id}: ${magicUrl}\n\nThis link expires in 15 minutes and works once.`,
      });
      sendOk = true;
    } catch (err) {
      console.error('[oauth/authorize] send failed:', err && err.message);
    }
  }
  logAudit({ eventType: 'oauth_authorize_requested', success: sendOk });

  // Same confirmation page regardless of outcome.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(renderSent({ email }));
}

function buildEmailHtml(url, clientName) {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FDFCFA;margin:0;padding:0"><div style="height:6px;background:#FFE34A;width:100%"></div><div style="max-width:520px;margin:0 auto;padding:48px 32px"><div style="display:flex;align-items:center;gap:10px;margin-bottom:36px"><div style="width:24px;height:24px;background:#FFE34A;border:1.5px solid #0F0E0D;border-radius:4px;box-shadow:2px 2px 0 #0F0E0D"></div><span style="font-size:15px;font-weight:600;color:#0F0E0D">MyAITwin MCP</span><span style="font-size:10px;color:#857C6E;letter-spacing:0.1em;text-transform:uppercase;font-family:monospace">by Luto</span></div><h1 style="font-family:Georgia,serif;font-size:26px;font-weight:400;color:#0F0E0D;margin:0 0 16px;line-height:1.15">Connect ${clientName}.</h1><p style="font-size:15px;color:#3A352E;line-height:1.6;margin:0 0 32px">Click the link below to connect your twin. This link works once and expires in 15 minutes.</p><a href="${url}" style="display:inline-block;background:#FFE34A;color:#0F0E0D;text-decoration:none;padding:14px 28px;border-radius:8px;border:1.5px solid #0F0E0D;box-shadow:3px 3px 0 #0F0E0D;font-size:15px;font-weight:600">Connect ${clientName} &rarr;</a><div style="height:1px;background:#E8E2D4;margin:36px 0 24px"></div><p style="font-size:11px;color:#857C6E;line-height:1.7;margin:0;font-family:monospace">If you did not request this, ignore this email.</p></div></body></html>`;
}
