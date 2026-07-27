# Getting a user's ChatGPT / Claude / Gemini memory into Configure — what's actually possible (mid-2026)

This is the grounded answer after researching how the vendors' own memory
import/export works and how every shipping "portable memory" product actually
moves data. It exists so we stop re-deriving it.

## The one-line verdict

**No vendor exposes any door — no OAuth scope, no API, no connector — that lets a
third party read a user's saved memory, even with the user's explicit consent.**
Both OpenAI's and Anthropic's own cross-vendor memory-import tools are **copy-paste**.
The only thing that captures memory *hands-free* today is a **browser extension
that scrapes the logged-in web session**. There is no "the assistant exports its
own memory to your endpoint" feature — that has to be approximated with an MCP
"save" tool, which only sees what the assistant hands it, not the whole store.

## Why every automatic path is closed (with sources)

- **No read API / OAuth for memory.** "Sign in with ChatGPT" and OpenAI OAuth are
  identity/inference only — explicitly *not* memory or history. Anthropic's OAuth
  is locked to Claude Code/Claude.ai and using it elsewhere violates their ToS.
  A backend memory API is an open, unfulfilled request.
  (help.openai.com Apps SDK auth; openai/codex#10974; anthropics/claude-code#37205)
- **Connectors / MCP are inbound-only.** On both ChatGPT and Claude, a connector
  exposes *your* service's tools *to* the assistant; it cannot pull the assistant's
  memory *out*. (help.openai.com developer-mode MCP; platform.claude.com remote-mcp)
- **Official exports exclude memory.** The ChatGPT Data Export ZIP is
  conversations + account metadata — **not** the saved-memories list. Claude's GDPR
  export ZIP is conversations only. Both are manual, emailed, expiring links.
  (help.openai.com 7260999 / 9106926; privacy.claude.com 9450526)
- **No internal memory-list endpoint.** `chatgpt.com/backend-api/*` exposes custom
  instructions and conversations, but there is no documented saved-memories
  ("bio tool") list route; products scrape the Manage-Memories DOM instead.
  Claude blocks non-browser traffic to its internal API. (terminalcommandnewsletter/
  everything-chatgpt; embracethered.com memory deep-dive)
- **The model won't emit it.** Tested on real ChatGPT: it will encode text the user
  brings into the chat and build a tap-link, but it refuses to reach into its
  hidden saved-memory and put that into any outbound artifact. That's the
  anti-exfiltration guardrail; the only "bypass" is prompt injection, which is a
  data-theft weapon and is out of scope.

## What actually ships (ranked, most→least legitimate)

1. **Google Data Portability API** — the *only* sanctioned OAuth hands-free pull,
   and only for Google/Gemini **activity** (not a live memory object; a Gemini
   memory scope is unconfirmed). Not applicable to ChatGPT/Claude.
2. **MCP "save" tool** the user invokes inside the assistant — official rails,
   consented, but captures only what the assistant passes into the call (a slice of
   the current context), not the full memory store. Works on mobile (in-app), needs
   a one-time connector add. This is the `configure_profile_import`-style pattern.
3. **ChatGPT Apps SDK write-action + "Open in app" deep link** — official but saves
   chat-*generated* content to the app's backend, not the memory store; dev-mode /
   paid-gated.
4. **Browser extension scraping the Manage-Memories or chat DOM** — the only thing
   doing genuine hands-free *memory* capture today (MemoryPlugin adds a Sync button
   to ChatGPT's Manage-Memories page; mem0/OpenMemory scrapes the live chat DOM →
   its API). Desktop only, fragile (breaks on UI changes), rides the user session,
   ToS-gray.
5. **Manual emailed ZIP** — official, not hands-free, and ChatGPT's excludes memory.
6. **Copy-paste prompt dump** — official for Claude; what the vendors themselves
   ship. Not hands-free.

Only #4 (extension) captures the actual memory with no user copy step. Only #1 is a
real OAuth pull, and it doesn't cover ChatGPT/Claude memory.

## What this means per surface

- **Desktop, truly hands-free (the "new thing"):** a Configure **browser extension**
  that reads the user's Manage-Memories page (ChatGPT) / memory settings (Claude)
  and POSTs to Configure's `/{token}/ingest`. This is exactly what MemoryPlugin and
  mem0 ship — a proven pattern, not a hack. Fragile and desktop-bound, but it's the
  only mechanism that gets the full memory with no user handling.
- **Mobile:** there is **no** hands-free full-memory export. Nothing exists to build.
  The realistic mobile paths are the MCP save-tool (one-time connector, partial /
  ongoing capture) or user paste.
- **Ongoing / cross-assistant:** the MCP save-tool (#2) is the clean official path
  for "going forward, save what we discuss" — but it is not a retroactive dump of
  the existing memory store.

## Recommendation

There is no single mechanism that is hands-free **and** full-store **and** mobile —
that combination does not exist at any vendor. Ship the two that are real and let
them cover each other:

1. **Configure browser extension (desktop)** — the only true hands-free capture of
   the existing memory. Highest-value "new thing" beyond paste.
2. **MCP save-tool (mobile + ongoing)** — one-time connector, then "save this to
   Configure" works in-app; captures forward context, not the old store.
3. Keep **paste-into-Configure** as the universal floor (already built via
   `/{token}/ingest`).

The URL-fetch / tap-link work already in this package is the best *no-extension,
no-connector* effort, but it is inherently limited to memory the user surfaces into
the chat, because the vendors will not let the model export its hidden store.
