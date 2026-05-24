# MyAITwin MCP

A personal RAG database and semantic search engine you build and control
from inside your AI chat. Store your knowledge, voice, and skills as you
work. Retrieve them in seconds, source always cited. Your AI then creates
output that is recognisably you, in every conversation.

Live at https://myaitwin.lutolearn.com. Free during early access.

## What it is

MyAITwin is two things at once.

**The toolbox.** A production-grade RAG database with semantic search that
you shape from chat. You define the structure, the types, the tags. It is
yours, it is visible, and you are the architect of it.

**The twin.** The layer on top that greets you, guides you, assesses what
you store, and creates output that sounds like you. It knows the difference
between what you know (your knowledge) and how you say things (your skills),
and it uses both.

## Install

Three steps. Under two minutes.

1. Sign up at https://myaitwin.lutolearn.com/ with your email.
2. Click the magic link, then copy your personal MCP URL from `/create`.
3. In Claude Desktop: Settings → Connectors → Add custom connector → paste your URL.

Or use the canonical OAuth-authenticated endpoint:

- **URL:** `https://myaitwin.lutolearn.com/mcp`
- **Transport:** Streamable HTTP
- **Auth:** OAuth 2.1 with PKCE (S256) and Dynamic Client Registration

Requires a client with MCP capability. Currently Claude Pro, Claude Team,
and ChatGPT Pro.

## The 19 tools

**Storing knowledge**

| Tool | What it does |
|---|---|
| `add_knowledge` | Store a typed, tagged knowledge item |
| `add_voice_note` | Store a voice note transcript with automatic extraction |
| `add_document` | Store a long document with automatic chunking |
| `add_from_url` | Fetch and store a web page |
| `add_reference_record` | Store a creation event linking knowledge and skills used |

**Retrieving knowledge**

| Tool | What it does |
|---|---|
| `search_twin` | Semantic search across all knowledge |
| `search_for_creation` | Dual search returning skills and knowledge separately |
| `get_by_type` | Retrieve all items of a specific type |
| `get_by_tag` | Retrieve all items with a specific tag |
| `list_recent` | List recently added items |

**Understanding your twin**

| Tool | What it does |
|---|---|
| `get_schema` | Overview of your types and how many items you have |
| `get_sources` | List all source documents |
| `find_patterns` | Surface recurring patterns across your knowledge |
| `synthesise` | Synthesise across multiple knowledge items on a topic |

**Managing your twin**

| Tool | What it does |
|---|---|
| `get_welcome` | Session initialisation and system prompt |
| `update_knowledge` | Update an existing item |
| `add_schema_type` | Define a new knowledge type |
| `update_schema_type` | Update an existing type definition |
| `delete_knowledge` | Delete an item (destructive) |

All tools are annotated with `title`, `readOnlyHint`, and `destructiveHint`
per the MCP spec. Of the 19: 10 read-only, 8 write (non-destructive), 1
destructive (`delete_knowledge`).

## How it works

RAG is Retrieval-Augmented Generation. It is the architecture that lets AI
answer using your specific knowledge rather than its training data alone.

Two layers:

- **Supabase (PostgreSQL)** for structured records with types, tags, and provenance.
- **Pinecone** for vector embeddings, so you can search by meaning rather than exact words.

When you search, both layers work together and return results ranked by
relevance. Every result is cited with source and date, and tagged with
provenance: personal (your own thinking), organisational (from your
organisation), or external (from someone else).

The architectural insight worth getting right:

**Knowledge** is what you know. Facts, decisions, transcripts, observations.

**Skills** are how you express things. Your LinkedIn voice. Your email
style. Your proposal structure.

Exceptional output needs both. Take a meeting transcript and ask for a
follow-up email. The twin needs the transcript and your email skill to
produce something that is accurate and unmistakably yours. Neither alone is
enough.

## Security and privacy

- Bearer token authentication on every request, hashed at rest.
- OAuth 2.1 with PKCE for connector-style integration. No shared secrets,
  no static credentials.
- Multi-tenant data isolation: each user lives in their own namespace.
  Other users can never read your data. Verified by a 35-check cross-tenant
  test suite.
- Rate limiting per tenant.
- Append-only audit log on every tool call.
- Prompt injection guardrails on stored content.
- Your data is used only to provide the service. Never used to train AI
  models. Never shared with third parties.
- You can delete your account and all data instantly from `/create`.
  Deletion is immediate and irreversible.

Privacy policy: https://myaitwin.lutolearn.com/privacy
Security contact: security@lutolearning.com
Privacy contact: privacy@lutolearning.com

## Distribution

- **Official MCP Registry:** [`com.lutolearn/myaitwin`](https://registry.modelcontextprotocol.io/v0/servers?search=myaitwin)
- **Anthropic Connectors Directory:** submitted, in review
- **Listed at:** Glama, mcp.so, mcp.directory, mcpserverfinder, Hugging Face,
  awesome-mcp-servers

## License

MIT. See [LICENSE](./LICENSE).

## Links

- Website: https://myaitwin.lutolearn.com
- Documentation: https://myaitwin.lutolearn.com/docs
- Privacy: https://myaitwin.lutolearn.com/privacy
- Support: support@lutolearning.com

---

*MyAITwin MCP by Luto.*
