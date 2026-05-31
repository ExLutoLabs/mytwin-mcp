# Chat Surface Architecture
_Produced by the May 2026 holistic bug audit. Update whenever any of these surfaces changes._

---

## 1. Conversation assembly

### Client side (public/twin.html)

The client maintains `state.history: [{role, content}]` in memory (twin.html:1457).

On every submit, the request body sent to `/api/twin/turn` is:

```js
{
  text:    "<current user message>",
  history: state.history.slice(-12),   // last 12 entries (6 user + 6 assistant pairs)
  context_concept_ids?: [...]           // optional pinned concept page IDs
}
```

After a response, `state.history` is updated:
- **Chat turns (SSE `done` event):** both `{role:'user', content: text}` and `{role:'assistant', content: accumulated}` are pushed (twin.html:2293-2294).
- **Ambiguous turns (SSE `meta` event, kind `ambiguous`):** both user message and clarifying-question text are pushed (twin.html:2260-2261).
- **Store-proposal turns (SSE `meta` event, kind `store-proposal`):** NEITHER the user message NOR the proposal is pushed (twin.html:2256 — deliberate comment "// Not added to chat history").

The store-proposal omission is the frontend half of the RC1 bug: after a proposal card is shown, the next turn's history does not contain the proposed content.

### Server side (api/twin/turn.js)

```
request.body.history.slice(-12)        // server re-slices (line 494)
→ classifyIntent(text, history.length > 0)   // BOOLEAN ONLY passed to classifier (line 545)
→ branch on intent:
    STORE:     sse.send('meta', {kind:'store-proposal', proposal:{...cls.proposal, content: text}})
               — no Sonnet call, no history used
    AMBIGUOUS: sse.send('meta', {kind:'ambiguous', text: cls.clarifying_question})
               — no Sonnet call, no history used
    CHAT:      messages = history.map(...) + push({role:'user', content: contextBlock + text})
               → streamTwin({messages, ...})   // full history IS sent to Sonnet
```

**Key finding:** history reaches Sonnet correctly in the CHAT branch. The bug is that `classifyIntent()` receives only a boolean `hasHistory` (line 545: `classifyIntent(text, history.length > 0)`), never the actual history content. The STORE branch builds `content: text` regardless of whether `text` is a short reference to prior content.

---

## 2. Retrieval pipeline

### Tool routing (api/twin/turn.js:597-622)

| Mode | Retrieval call | Notes |
|---|---|---|
| `creation` | `searchForCreation(ctx, {query, output_type})` | dual retrieval: skills bucket + knowledge bucket |
| `general` / `browse` | `searchTwin(ctx, {query: querySeed, top_k: 6})` | semantic only |
| all | `listRecent(ctx, {limit: 100})` | called ONLY for stage inference (item count), NOT for retrieval response |

There is **no temporal/recency routing branch**. Queries like "what did I save today" go through `searchTwin` (semantic) regardless of the temporal signal in the text.

### Context injection (turn.js:626-632)

Retrieval results are converted to an XML block via `buildKnowledgeBlock()` and PREPENDED to the user's current message before being passed to Sonnet:

```js
messages.push({ role: 'user', content: contextBlock + text });
```

This is an append pattern, not an overwrite. Prior history messages are preserved verbatim.

---

## 3. Intent classification

### Classifier function (api/twin/turn.js:260-281)

The inline classifier (`classifyIntent`) is called with:

```js
classifyIntent(text, history.length > 0)
```

It calls `callFastJson` (Haiku model) with:
- A boolean context hint: `[There is conversation history — the user is mid-chat.]` or `[This is an early message in the conversation.]`
- The current user message in `<user_message>` tags

**The classifier never sees the history content.** It cannot know that "store it as a contact" refers to Jack Fannon's email stated two turns earlier.

### Classification outcomes and dispatch

| intent | chat_mode | action in turn.js |
|---|---|---|
| `store` | — | emit store-proposal SSE, close. No model call. |
| `ambiguous` | — | emit ambiguous SSE, close. No model call. |
| `chat` | `general` | searchTwin + Sonnet stream |
| `chat` | `browse` | searchTwin + Sonnet stream (browse instructions) |
| `chat` | `creation` | searchForCreation + Sonnet stream (dual retrieval) |

**No `recent` or temporal chat_mode exists.** There is no route to `listRecent` for retrieval.

### Spells (turn.js:383-401)

Before the classifier, regex patterns check for `accio:`, `revelio:`, `synthesise:`. Matched spells bypass the classifier or force a specific mode.

---

## 4. Identity resolution

### Server helpers (lib/auth.js, lib/anon.js)

**`requireAuth(req)`** (lib/auth.js): reads `mt_session` cookie, verifies HS256 JWT, returns `{userId, email}` or null. No anon fallback.

**`requireTenant(req)`** (lib/anon.js): unified resolver. Fallback order:
1. Call `requireAuth(req)`. If valid: DB lookup for `tenant_id`. Return `{userId, tenantId, isAnonymous: false}`.
2. Read `X-Anon-Token` header. If valid JWT with `kind === 'anon'`: return `{userId, tenantId, isAnonymous: true}` from JWT payload.
3. Return null (caller sends 401).

### Per-route resolver table

| Route / page | Server resolver | Notes |
|---|---|---|
| `api/twin/turn` | `requireTenant` | cookie preferred over anon token |
| `api/twin/knowledge/*` | `requireTenant` | same |
| `api/library/concepts` | `requireTenant` | same |
| `api/library/items` | `requireTenant` | same |
| `api/account` | `requireAuth` | session cookie ONLY, no anon fallback |

### Frontend session state (public/twin.html)

`validateSession()` (twin.html:1580) calls `/api/auth/session`, writes `mt_is_authenticated` and `mt_user_email` to `localStorage`, then calls `updateHeader()`.

`ensureSession()` (twin.html:1720) reads/mints an anon token into `localStorage['mt_anon_token']` and `state.anonToken`.

Both run at boot, and every API call from twin.html sends `X-Anon-Token: state.anonToken` if present. Session cookie is also sent automatically by the browser.

### Identity divergence: library.html

`public/library.html` has a **static hardcoded "Sign in" link** (library.html:892) and **no `validateSession()` or `updateHeader()` call**. The header always shows "Sign in" regardless of auth state, even while API data loads correctly (because the server's `requireTenant` resolves via the session cookie on the API calls). This is the root cause of symptom 6 (identity flicker) and symptom 7 (Wiki empty state when session resolves to wrong tenant).

---

## 5. Response composition

### Post-processing (api/twin/turn.js:668-694)

After retrieval and citation assembly, Sonnet is called via `streamTwin()`. Each text delta is emitted as an SSE `token` event. No post-processing (sanitiser, regex, etc.) runs on the server side — the em-dash rule is enforced by the system prompt instruction.

### Typing indicator lifecycle (public/twin.html)

1. User submits. Three pulsing dots (`renderLoading()`, twin.html:2013-2020) appear immediately.
2. SSE `meta` event with `kind: 'chat'` arrives:
   - Loading dots are **removed** (`loading.remove()`).
   - An empty `.msg-twin` bubble is created.
   - Its content is set to `<span class="streaming-cursor"></span>` — a 2px blinking caret.
3. SSE `token` events arrive: accumulated text + cursor rendered progressively.
4. SSE `done` event: cursor removed, final content rendered.

**Between step 2 and step 3** (the "meta received, first token not yet arrived" window), the page shows only a bare blinking caret with no surrounding text or bubble background. This is symptom 10.

---

## 6. Brain Wiki render path

### Data flow

- `public/library.html` Wiki view calls `GET /api/library/concepts` (library.html:1236).
- `api/library/concepts.js` queries `concept_pages` filtered by `user_id = ctx.userId` AND `tenant_id = ctx.tenantId`, then splits by `flavour` into `{knowledge: [...], skills: [...]}`.
- `public/account.html` Account page calls `GET /api/account`, which queries `concept_pages` COUNT filtered by `user_id = session.userId` AND `tenant_id = user.tenant_id`.

### Empty-state condition (library.html:1453)

The Wiki shows "not compiled yet / still compiling" when `knowledge.length + skills.length === 0`.

### Why Account=9 while Wiki=0

The queries are structurally identical. A discrepancy requires `ctx.userId/ctx.tenantId` in the library route to differ from `session.userId/user.tenant_id` in the account route.

Account uses `requireAuth` (session cookie only). Library uses `requireTenant` (cookie preferred, anon fallback). If the library page's request resolves via the anon token instead of the session cookie (because the session cookie is absent, expired, or the library fetch lacks credentials), `requireTenant` returns the anonymous user who has zero concept_pages. The account page simultaneously shows the authenticated user's nine pages because its cookie-only resolver happened to succeed.

Live DB probe (31 May 2026): all 40 concept_pages across all tenants have `flavour` of `'knowledge'` (27) or `'skills'` (13). There are no legacy `'thinking'/'craft'` values. The flavour filter is not the cause.

**Root cause is identity divergence at the library route** (RC4). Fix: add `validateSession()` + proper auth header logic to library.html, ensuring the session cookie is the active identity for all library API calls.
