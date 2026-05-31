# Profile v1 — Architecture findings (Sub-phase 0, read-only)

Investigation for the Profile v1 build. Read-only. No code changed. Date: 2026-05-31.

## 1. Current Account page (`public/account.html` → `/twin/account`)

Light "paper" theme (Source Serif 4 / Inter / JetBrains Mono, `#f5f3ef` background).
NOT the dark twin-domains style Profile must adopt, so the ported Settings controls
need restyling to dark.

Renders and the endpoints behind each piece:

| Piece | Source |
| --- | --- |
| Auth check | `GET /api/auth/session` → `{ is_authenticated, email }`; redirect to `/twin` if not authed |
| Email, member-since, item/concept counts, shared tokens | `GET /api/account` → `{ email, created_at, item_count, concept_page_count, shared_tokens[] }` |
| Generate shared MCP link | `POST /api/account/shared-token` → `{ token, id, prefix, created_at }` (raw token shown once) |
| Revoke shared link | `DELETE /api/account/shared-token` |
| Sign out | clears `mt_*` localStorage, `POST /api/auth/signout`, redirect `/twin` |
| Delete account | `DELETE /api/account` with body `{ confirm: 'DELETE-MY-ACCOUNT' }` |

Shared-link URL form: `https://myaitwin.lutolearn.com/mcp/shared/{rawToken}`.

These handlers will be ported verbatim into `profile.html` (restyled), not redesigned.

## 2. Identity / session resolution

- **Server-side**: `requireAuth(req)` (`lib/auth.js`) reads the `mt_session` HttpOnly
  JWT cookie and returns `{ userId, email }` or `null`. This is the primitive the new
  API endpoints use. Returns 401 when absent.
- **Frontend**: there is no function literally named `validateSession`. The audit's RC4
  fix added `syncHeaderAuth()` in `library.html` (mirrors `twin.html`): `GET /api/auth/session`
  → `{ is_authenticated, email }`, toggles header auth state, caches to `mt_is_authenticated`
  / `mt_user_email`. Profile reuses this exact pattern on load and redirects to `/twin`
  when unauthenticated.

## 3. Workspaces backfill state (live prod DB, read-only probe)

| Metric | Value |
| --- | --- |
| personal workspaces | 54 |
| total workspaces | 54 |
| distinct personal-workspace owners | 54 |
| workspace memberships | 54 |
| distinct knowledge users | 17 |
| knowledge rows total | 399 |
| **knowledge rows with null workspace_id** | **5** |
| concept_pages total / null workspace | 40 / 0 |
| permissions rows | 0 |
| invitations rows | 0 |

- Every user has exactly one Personal workspace + owner membership. Backfill (P1.2) ran.
- **5 knowledge items still have `workspace_id = NULL`.** These are items inserted AFTER
  the backfill: the insert path (`api/twin/knowledge`, confirm-store, etc.) does not yet
  stamp `workspace_id` (that is Phase 1 P1.4+, paused). **Implication for the endpoint:**
  a strict `WHERE workspace_id = $ws` filter would hide these from their owner's own
  Profile. Chat retrieval filters by `user_id`, not `workspace_id`, so it is unaffected.
  **Decision for Sub-phase 1:** for the owner viewing their own personal workspace,
  select owned items by `(workspace_id = $ws OR (workspace_id IS NULL AND user_id = $requester))`
  so null-workspace items fall into the owner's personal workspace (matching backfill
  semantics). Non-owner/shared views use the strict permission join only.
- `permissions` and `invitations` are empty in prod — **sharing has not started**, so
  Sub-phase 1 and 5 share/permission tests must create their own synthetic grants
  (ideally in a throwaway test tenant), never relying on prod data.

## 4. Permission-aware retrieval state

`lib/permissions.js` exposes `getAccessibleSharedItems(ctx)` and it is wired into
`tools/retrieval.js` (searchTwin, getByType, getByTag, synthesise) — these are in the
working tree as uncommitted/modified files (audit + Phase 1 changes). That helper resolves
**items shared TO the requester** (per-item grants at `can_use`+), grouped for
cross-namespace Pinecone queries. It is NOT workspace-scoped and does not enumerate an
owner's own workspace items.

**Decision:** the hypergraph endpoint applies permission filtering **directly** (the
brief's fallback path), not via the retrieval helper, because the helper answers a
different question (shared-to-me) than the hypergraph needs (all accessible items in a
target workspace). `USABLE_LEVELS = ['can_use','can_edit','full_access']` is reused as the
threshold constant.

## 5. Knowledge & edge data shape

`knowledge` columns (composite of v2.sql + migrations 001/005/014/016/018):

```
id uuid pk, user_id uuid, tenant_id uuid, type text, title text, content text not null,
source_type text, source_ref text, tags text[], pinecone_id text,
provenance text  -- personal | organisational | employer | client | external
visibility text  -- private | sharable  (default private)
workspace_id uuid  -- nullable, FK workspaces(id)
created_at, updated_at timestamptz
```

Live provenance distribution: personal 269, employer 88, client 28, external 12,
organisational 2 (legacy stragglers). Four-way provenance (v2 spine) shipped.

- No edges table. Edges are computed on the fly from tag co-occurrence: per item, top-2
  most-similar siblings by shared-tag count; dedupe i↔j; strength = number of shared tags.
- Degree = number of edges incident to the node after dedupe.
- `concept_pages`: id, tenant_id, user_id, title, flavour, …, workspace_id (all assigned).

## 6. Hypergraph reference visual — RESOLVED

`twin-domains-tight.html` was not on disk, but the user has supplied the verbatim rendering
spec (every constant, structure, and behaviour). Captured in
[profile-hypergraph-render-spec.md](profile-hypergraph-render-spec.md) — the canonical
reference for Sub-phases 3-4. SPREAD=50, JITTER_MULT=23, GAP=2.0, ITER=120, six-domain
palette, lighting/fog/grain/halo, hover/drag/zoom, starfield, container-sizing adaptation,
and the empty-state placeholder treatment are all specified there. No longer a blocker.

One hardening note carried into Sub-phase 3: the reference tooltip injects `it.title` via
`innerHTML`; Profile must escape user-supplied titles (titles are user data).

## Open design questions (flag before building)

1. **Sharable-link Profile view (Sub-phase 5, test 3).** `/mcp/shared/{token}` resolves a
   shared token to the OWNER's `{ userId, tenantId }` with `visibilityFilter='sharable'`.
   An anonymous Profile view therefore needs the hypergraph endpoint to optionally accept a
   shared token (not just a session) and apply the `sharable` visibility filter. The
   endpoint spec only mentions `workspace_id` + session auth. Resolve token-auth shape for
   the endpoint before Sub-phase 5 (does not block Sub-phase 1's session path).
2. **Shared working tree.** This repo on disk currently holds another agent's uncommitted
   changes (`turn.js`, `library.html`, `twin.html`, `retrieval.js`, `vercel.json` modified;
   `lib/permissions.js`, `lib/sharing.js`, `api/items/`, `api/invitations/`, migrations
   018/019, scripts untracked). `feature/profile-v1` shares this single checkout, so a
   branch switch moves HEAD for whatever else uses this directory. Confirm branch strategy
   before committing (and only ever `git add` Profile's own new files).

## Sub-phase 1 plan (pending approval)

New files only: `api/profile/hypergraph.js`, `api/profile/index.js`. Auth via `requireAuth`.
Default `workspace_id` = requester's personal workspace (`workspaces.owner_id = userId,
type='personal'`). Owner path includes null-workspace owned items (see §3). Non-owner path:
permission join at `USABLE_LEVELS`. Every query scoped by `tenant_id`. Edges + degree +
static six-domain inference computed in-endpoint. Tests per brief (auth, 403, can_use vs
can_view threshold, multi-tenant isolation) against a synthetic test tenant.
