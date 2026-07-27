# Memory Sync — export ChatGPT / Claude memory into Configure by pasting one line

Memory Sync lets a Configure user move the memory a consumer assistant (ChatGPT,
Claude, Gemini, Grok) has saved about them into their own Configure profile —
without adding a connector and without copy/pasting a wall of memory text.

The whole flow is one paste:

```
User: "use sign-in.me/sync to sync my memories.
        read sign-in.me/sync/<token>/llms.txt for instructions"

  1. sign-in.me/sync            -> quick auth (Configure SSO)
  2. issues sign-in.me/sync/<token>  (unique, expiring, bound to this user)
  3. user pastes it into ChatGPT / Claude
  4. the assistant recalls the user's memory and OPENS a URL with the memory
     appended in the path:
        sign-in.me/sync/<token>/m/<url-encoded memory>
  5. our server sees that hit, resolves <token> -> the Configure user, and
     commits the memory to their profile.
```

Step 4 is the key: a normal chat assistant already has a **web/URL tool**. We do
not need it to call a custom tool or add a connector — we only need it to open a
URL. The memory rides in the URL path; the server on the other end turns that
"someone fetched this URL with data appended" event into a profile write for the
signed-in user.

## Why the memory goes in the URL path

The assistant's only universally available capability is "open this URL". So the
transport is a URL, and the payload is the part after `/m/`:

```
https://sign-in.me/sync/mst_9f3a/m/likes%20tea%0Abased%20in%20NYC
                                    └──────── the user's memory ────────┘
```

- Everything after `/m/` is the memory, URL-encoded. Newlines are `%0A`; each line
  becomes one memory.
- Extra path segments (`/m/likes%20tea/based%20in%20NYC`) are each treated as a
  separate memory.
- For long memory, the assistant slices the encoded text into several
  `?seq=/&data=` chunk fetches and finishes with one `/commit` — the server
  reassembles in order.

Keep each opened URL reasonably short (the generated `llms.txt` advises
~1500 encoded characters) and prefer the path form; it is the shape most likely to
be opened across models. If one model refuses, the same token also accepts a plain
`POST /{token}/ingest` and the chunk+commit route.

## Wire it into the Configure sign-in (SSO) flow

The unique link is minted from the same Configure sign-in the rest of this SDK
uses — `signInUrl` starts the quick auth, `completeSignIn` finishes it and mints
the bound sync token.

```ts
import { createMemorySync, localMemorySyncStore } from "configure-spectrum";

const sync = createMemorySync({
  apiKey: process.env.CONFIGURE_API_KEY!,        // sk_...
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!, // pk_...
  agent: process.env.CONFIGURE_AGENT!,
  store: localMemorySyncStore(),                 // swap for a durable store
  origin: "https://sign-in.me",
  basePath: "/sync",
});

// GET /sync  -> send the user to hosted quick auth, returning to our callback.
function startSignIn(): string {
  return sync.signInUrl({ returnTo: "https://sign-in.me/sync/complete", source: "chatgpt" });
}

// GET /sync/complete?code=...  -> exchange the code for the user's Configure
// identity and mint their personal sync link.
async function onSignInReturn(code: string) {
  const ticket = await sync.completeSignIn({ code, source: "chatgpt" });
  // Show the user ticket.syncUrl and ticket.prompt — that is all they paste.
  return ticket;
}
```

A `ticket` is:

```jsonc
{
  "token": "mst_9f3a…",
  "syncUrl": "https://sign-in.me/sync/mst_9f3a…",
  "instructionsUrl": "https://sign-in.me/sync/mst_9f3a…/llms.txt",
  "saveUrlTemplate": "https://sign-in.me/sync/mst_9f3a…/m/<url-encoded-memories>",
  "prompt": "Export everything you remember about me to my Configure profile. First open …/llms.txt and follow it exactly. My personal sync link is …",
  "expiresAt": "…"
}
```

If the user is already linked elsewhere in your app (e.g. a Spectrum message
thread where the adapter already holds their Configure token), skip the sign-in
and mint directly:

```ts
const ticket = await sync.issue({ configureToken: ctx.identity.token, source: "chatgpt" });
```

## Serve the sync routes

Mount `sync.fetchHandler` (WHATWG `fetch`-style) under `basePath`:

```ts
export function handleSync(request: Request): Promise<Response> {
  return sync.fetchHandler(request); // Bun/Deno/Hono/Next route handlers/workers
}
```

| Method + path | Purpose |
| --- | --- |
| `GET /{token}/m/<memory>` | **primary** — memory appended in the path, saved immediately |
| `GET /{token}/chunk?seq=&data=` | buffer one slice of a long memory |
| `GET \| POST /{token}/commit` | reassemble buffered slices → save |
| `POST /{token}/ingest` | JSON `{ memories }` / `{ text }` (connectors/tools) |
| `GET /{token}/ingest?data=` | single small payload → save |
| `GET /{token}/status` | token state + committed count |
| `GET /llms.txt`, `GET /{token}/llms.txt` | instructions for the assistant |

Every route resolves `{token}` to the bound Configure identity and writes with
`profile.commit({ memories })`. An unknown token is `404`; an expired one is `410`.

## The paste + the instructions

`ticket.prompt` is the single line the user pastes. It points the assistant at
`ticket.instructionsUrl`, whose body (`sync.instructions({ token })`) tells the
assistant to:

1. recall everything it has saved about the user, one memory per line;
2. URL-encode it and open `…/{token}/m/<encoded>` (or chunk + commit if long);
3. report the `{"ok":true,"committed":N}` count.

## Security & consent

- User-initiated and consented: the flow only moves the user's **own** memory into
  the user's **own** Configure profile, and only after they signed in to mint the
  link.
- Every write is bound to a Configure token resolved from the sign-in; the endpoint
  fails closed without a valid, unexpired token.
- Sync tokens (`mst_`) are short-lived (default 30 min) and single-user.
- `llms.txt` tells the assistant to skip secrets (passwords, keys, one-time codes,
  full card/account numbers); the ingestion core caps count and size and
  de-duplicates.
- This is data portability. Do not repurpose the endpoint to read a profile the
  acting user does not own.

## Notes on model behavior

Some model configurations are cautious about opening long or unusual URLs. To
maximize success: prefer the `/m/<memory>` path form, keep each opened URL short,
and fall back to the chunk+commit route for long memory. The token is reusable
until it expires, so a partial sync can be re-run; memories are merged, not
duplicated.
