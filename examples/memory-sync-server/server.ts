/**
 * Configure Memory Sync — minimal, dependency-free server.
 *
 * A signed-in user gets a unique link; pasting it into ChatGPT/Claude makes the
 * assistant open `/sync/<token>/m/<memories>`, which this server saves to their
 * Configure profile. No connector, no copy/paste of the memory blob.
 *
 * Routes:
 *   GET  /sync                      -> redirect to Configure quick auth (SSO)
 *   GET  /sync/complete?code=...    -> mint the user's personal sync link
 *   GET  /sync/<token>/m/<memories> -> save memory to the user's profile
 *   GET  /sync/<token>/llms.txt     -> instructions for the assistant
 *   ... plus /chunk, /commit, /ingest, /status (handled by the SDK)
 *
 * Run: CONFIGURE_API_KEY=sk_... CONFIGURE_PUBLISHABLE_KEY=pk_... \
 *      CONFIGURE_AGENT=your-agent npx tsx server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMemorySync, localMemorySyncStore } from "configure-spectrum";

const apiKey = process.env.CONFIGURE_API_KEY;
const publishableKey = process.env.CONFIGURE_PUBLISHABLE_KEY;
const agent = process.env.CONFIGURE_AGENT;
if (!apiKey || !publishableKey || !agent) {
  console.error("Set CONFIGURE_API_KEY, CONFIGURE_PUBLISHABLE_KEY, and CONFIGURE_AGENT.");
  process.exit(1);
}

const origin = process.env.SYNC_ORIGIN ?? "http://localhost:8787";
const store = localMemorySyncStore(); // swap for a durable store in production

const sync = createMemorySync({ apiKey, publishableKey, agent, store, origin, basePath: "/sync" });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", origin);

  // Entry: start Configure quick auth, returning to our callback.
  if (url.pathname === "/sync" && !url.search) {
    const signIn = sync.signInUrl({ returnTo: `${origin}/sync/complete`, source: "chatgpt" });
    res.statusCode = 302;
    res.setHeader("location", signIn);
    return res.end();
  }

  // Callback: exchange the code for the user's identity and show their link.
  if (url.pathname === "/sync/complete") {
    const code = url.searchParams.get("code");
    if (!code) return sendJson(res, 400, { error: "missing_code" });
    try {
      const ticket = await sync.completeSignIn({ code, source: "chatgpt" });
      return sendJson(res, 200, {
        message: "Paste `prompt` into ChatGPT or Claude to sync your memory.",
        syncUrl: ticket.syncUrl,
        prompt: ticket.prompt,
        expiresAt: ticket.expiresAt,
      });
    } catch (error) {
      return sendJson(res, 401, { error: "sign_in_failed", detail: String(error) });
    }
  }

  // Everything else under /sync/* — the token routes and llms.txt.
  if (url.pathname.startsWith("/sync/")) {
    return send(res, await sync.fetchHandler(await toRequest(req, origin)));
  }

  sendJson(res, 404, { error: "not_found" });
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => {
  console.log(`Memory Sync server on ${origin}`);
  console.log(`  Start sign-in:  GET ${origin}/sync`);
  console.log(`  Instructions:   GET ${origin}/sync/<token>/llms.txt`);
  console.log(`  Save (by URL):  GET ${origin}/sync/<token>/m/<url-encoded-memories>`);
});

// --- node:http <-> web fetch adapters --------------------------------------

async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readRaw(req) : undefined;
  return new Request(new URL(req.url ?? "/", base), { method, headers, body });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(await response.text());
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
