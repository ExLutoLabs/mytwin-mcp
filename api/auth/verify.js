// GET /api/auth/verify?token=... — validate magic link, create session
import { verifyMagicToken, getOrCreateUser, createSessionToken } from '../../lib/auth.js';
import { logAudit } from '../../lib/audit.js';

const APP_URL = process.env.APP_URL || 'https://myaitwin.lutolearn.com';

// ── Flash error helper ────────────────────────────────────────────────────────
// Sets a short-lived cookie that the landing page reads and clears on load.
// Errors never appear in the URL — keeps the address bar clean.
function flashError(res, userMessage) {
  const cookie = `auth_flash=${encodeURIComponent(userMessage)}; Path=/; Max-Age=60; SameSite=Lax`;
  res.setHeader('Set-Cookie', cookie);
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(302, { Location: `${APP_URL}/` });
  res.end();
}

// Unified user-facing message for ALL token errors — invalid, expired, used,
// missing, or unexpected. Per security brief item 13: auth errors must not
// reveal which sub-state failed (prevents fingerprinting valid vs. invalid
// tokens). Raw err.message is never surfaced.
const GENERIC_AUTH_ERROR = 'This sign-in link didn’t work. Request a new one.';

function userMessageFor(_err) {
  return GENERIC_AUTH_ERROR;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const { token } = req.query;

  if (!token) {
    return flashError(res, GENERIC_AUTH_ERROR);
  }

  try {
    const { email, inviteCode } = await verifyMagicToken(token);
    // Open signups — match the OAuth callback flow. New users self-serve from
    // the landing-page email form; invited users still get their invite
    // redeemed + a personal outbound invite minted (handled inside
    // getOrCreateUser when inviteCode is set).
    const { user, isNew, mintedInviteCode } = await getOrCreateUser(email, { inviteCode, allowUninvited: true });
    const jwt = await createSessionToken(user.id, user.email);

    logAudit({
      userId:    user.id,
      tenantId:  user.tenant_id || null,
      eventType: 'magic_link_verified',
      success:   true,
      context:   { is_new_user: isNew, invite_redeemed: !!(isNew && inviteCode), minted_invite: mintedInviteCode || null },
    });

    // Set cookie explicitly, then serve an HTML page that navigates to /create.
    // Using a 200 + JS redirect (not 302) ensures the browser processes the
    // Set-Cookie header before following the navigation — some browsers silently
    // drop cookies from 302 redirect responses.
    const maxAge = 30 * 24 * 60 * 60;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Set-Cookie', [
      `mt_session=${encodeURIComponent(jwt)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
    ]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200;
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signing you in — MyAITwin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,500&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: #FDFCFA;
      color: #0F0E0D;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 24px;
      -webkit-font-smoothing: antialiased;
    }
    .yellow-bar {
      position: fixed; top: 0; left: 0; right: 0;
      height: 6px; background: #FFE34A;
    }
    .card { text-align: center; max-width: 360px; }
    .mark {
      width: 28px; height: 28px;
      background: #FFE34A;
      border: 1.5px solid #0F0E0D;
      border-radius: 4px;
      box-shadow: 2px 2px 0 #0F0E0D;
      margin: 0 auto 20px;
    }
    .wordmark {
      font-family: 'Source Serif 4', Georgia, serif;
      font-size: 1.05rem; font-weight: 500;
      letter-spacing: -0.01em;
      margin-bottom: 4px;
    }
    .byluto {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #857C6E;
      margin-bottom: 28px;
    }
    .msg {
      font-family: 'Source Serif 4', Georgia, serif;
      font-size: 1.25rem; font-weight: 500;
      letter-spacing: -0.01em;
      color: #0F0E0D;
      margin-bottom: 8px;
    }
    .sub {
      font-size: 13px; color: #857C6E;
    }
  </style>
</head>
<body>
  <div class="yellow-bar"></div>
  <div class="card">
    <div class="mark" aria-hidden="true"></div>
    <div class="wordmark">MyAITwin MCP</div>
    <div class="byluto">by Luto</div>
    <p class="msg">Signing you in…</p>
    <p class="sub">Taking you to your Twin.</p>
  </div>
  <script>
    // Redirect after a tick — gives the browser time to commit the Set-Cookie
    setTimeout(function() { window.location.href = '/create'; }, 50);
  </script>
</body>
</html>`);
  } catch (err) {
    console.error('auth/verify error:', err && err.message);
    // Audit the failure — no user_id yet (we couldn't resolve one)
    logAudit({
      eventType: 'magic_link_verified',
      success:   false,
      errorType: 'TokenRejected',
      errorMsg:  err && err.message,
    });
    flashError(res, userMessageFor(err));
  }
}
