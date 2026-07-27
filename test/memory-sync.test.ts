import { describe, expect, it } from "vitest";
import {
  createMemorySync,
  localMemorySyncStore,
  parseMemories,
  reassembleChunks,
} from "../src/index.js";

const baseOptions = {
  apiKey: "sk_test",
  agent: "test-agent",
  baseUrl: "https://api.test",
  origin: "https://sign-in.me",
};

interface CapturedCall {
  pathname: string;
  method?: string;
  body?: any;
}

function captureFetch(routes: Record<string, (body: any) => unknown> = {}) {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ pathname: url.pathname, method: init?.method, body });
    const handler = routes[url.pathname];
    const result = handler ? handler(body) : { status: "ok" };
    return new Response(JSON.stringify(result ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function fixedClock() {
  return () => new Date("2026-07-27T00:00:00.000Z");
}

describe("parseMemories", () => {
  it("accepts an array of strings", () => {
    expect(parseMemories(["likes tea", "based in NYC"]).memories).toEqual(["likes tea", "based in NYC"]);
  });

  it("accepts { memories } and { text }", () => {
    expect(parseMemories({ memories: ["a fact"] }).memories).toEqual(["a fact"]);
    expect(parseMemories({ text: "line one\nline two" }).memories).toEqual(["line one", "line two"]);
  });

  it("splits raw text and a JSON string", () => {
    expect(parseMemories("one\ntwo\n\nthree").memories).toEqual(["one", "two", "three"]);
    expect(parseMemories('["x fact","y fact"]').memories).toEqual(["x fact", "y fact"]);
  });

  it("strips list markers, trims, and drops trivially short lines", () => {
    const parsed = parseMemories("- likes tea\n* uses vim\n1. based in NYC\n\n.\nok");
    expect(parsed.memories).toEqual(["likes tea", "uses vim", "based in NYC", "ok"]);
  });

  it("de-duplicates case-insensitively", () => {
    expect(parseMemories(["Likes Tea", "likes tea"]).memories).toEqual(["Likes Tea"]);
  });

  it("enforces caps", () => {
    const many = Array.from({ length: 10 }, (_, i) => `fact ${i}`);
    expect(parseMemories(many, { maxMemories: 3 }).memories).toHaveLength(3);
    expect(parseMemories(["abcdefghij"], { maxMemoryChars: 4 }).memories).toEqual(["abcd"]);
  });
});

describe("reassembleChunks", () => {
  it("orders by seq and concatenates with no separator", () => {
    expect(
      reassembleChunks([
        { seq: 2, data: "three" },
        { seq: 0, data: "one\n" },
        { seq: 1, data: "two\n" },
      ])
    ).toBe("one\ntwo\nthree");
  });
});

describe("createMemorySync.issue", () => {
  it("mints a user-bound ticket with hosted links and a paste prompt", async () => {
    const store = localMemorySyncStore();
    const sync = createMemorySync({
      ...baseOptions,
      store,
      randomToken: () => "mst_fixed",
      now: fixedClock(),
      tokenTtlMs: 60_000,
    });

    const ticket = await sync.issue({ configureToken: "agent-token", source: "chatgpt", label: "Demo" });

    expect(ticket.token).toBe("mst_fixed");
    expect(ticket.syncUrl).toBe("https://sign-in.me/sync/mst_fixed");
    expect(ticket.instructionsUrl).toBe("https://sign-in.me/sync/mst_fixed/llms.txt");
    expect(ticket.ingestUrl).toBe("https://sign-in.me/sync/mst_fixed/ingest");
    expect(ticket.saveUrlTemplate).toBe("https://sign-in.me/sync/mst_fixed/m/<url-encoded-memories>");
    expect(ticket.providerSaveUrls.chatgpt).toBe("https://sign-in.me/sync/mst_fixed/from/chatgpt/m/");
    expect(ticket.providerSaveUrls.claude).toBe("https://sign-in.me/sync/mst_fixed/from/claude/m/");
    // capture prompt is benign recall; bookmarklet embeds the provider save base
    expect(ticket.capturePrompt.toLowerCase()).toContain("list everything you remember");
    expect(ticket.bookmarklet.startsWith("javascript:")).toBe(true);
    expect(decodeURIComponent(ticket.bookmarklet)).toContain("https://sign-in.me/sync/mst_fixed/from/chatgpt/m");
    expect(decodeURIComponent(ticket.bookmarklet)).toContain("window.open");
    expect(ticket.expiresAt).toBe("2026-07-27T00:01:00.000Z");
    // chatgpt is a known provider, so the paste prompt routes through /from/chatgpt/
    expect(ticket.prompt).toContain("https://sign-in.me/sync/mst_fixed/from/chatgpt/m/");
    expect(ticket.prompt.toLowerCase()).toContain("save");

    const record = await store.getSyncToken("mst_fixed");
    expect(record).toMatchObject({ configureToken: "agent-token", source: "chatgpt", label: "Demo" });
  });

  it("requires an identity to bind to", async () => {
    const sync = createMemorySync({ ...baseOptions, store: localMemorySyncStore() });
    await expect(sync.issue({})).rejects.toThrow(/configureToken|externalId/);
  });
});

describe("createMemorySync.instructions", () => {
  it("leads with the provider path-fetch pattern and includes fallbacks", () => {
    const sync = createMemorySync({ ...baseOptions, store: localMemorySyncStore() });
    const body = sync.instructions({ token: "mst_abc", source: "chatgpt" });
    // a known provider routes through /from/<provider>/ so it lands in that box
    expect(body).toContain("https://sign-in.me/sync/mst_abc/from/chatgpt/m/<URL-ENCODED-MEMORY-TEXT>");
    expect(body).toContain("https://sign-in.me/sync/mst_abc/from/chatgpt/m/likes%20tea%0Abased%20in%20NYC");
    expect(body).toContain("https://sign-in.me/sync/mst_abc/from/chatgpt/chunk?seq=0&data=");
    expect(body).toContain("https://sign-in.me/sync/mst_abc/from/chatgpt/commit");
    expect(body).toContain('"source":"chatgpt"');
  });

  it("uses the plain path when the source is not a known provider", () => {
    const sync = createMemorySync({ ...baseOptions, store: localMemorySyncStore() });
    const body = sync.instructions({ token: "mst_abc" });
    expect(body).toContain("https://sign-in.me/sync/mst_abc/m/<URL-ENCODED-MEMORY-TEXT>");
  });

  it("asks for a personal link when no token is bound", () => {
    const sync = createMemorySync({ ...baseOptions, store: localMemorySyncStore() });
    const body = sync.instructions();
    expect(body).toContain("<your-token>");
    expect(body).toContain("sign in");
  });
});

describe("createMemorySync ingest routes", () => {
  it("commits a POST /{token}/ingest body to the bound Configure profile", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch();
    const sync = createMemorySync({ ...baseOptions, store, fetch: fetchFn, randomToken: () => "mst_1" });
    await sync.issue({ configureToken: "agent-token", source: "chatgpt" });

    const res = await sync.handle({
      method: "POST",
      path: "/mst_1/ingest",
      body: { memories: ["likes tea", "based in NYC"], source: "chatgpt" },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, committed: 2 });
    const commit = calls.find((c) => c.pathname === "/v1/profile/commit");
    expect(commit?.body.memories).toEqual(["likes tea", "based in NYC"]);
  });

  it("reassembles chunked GET uploads and commits on /commit", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch();
    const sync = createMemorySync({ ...baseOptions, store, fetch: fetchFn, randomToken: () => "mst_2" });
    await sync.issue({ externalId: "ext-1", source: "claude" });

    // model opens the chunk URL twice, then commit — payload split mid-stream
    await sync.handle({ method: "GET", path: "/mst_2/chunk", query: { seq: "0", data: "likes tea\nuses " } });
    await sync.handle({ method: "GET", path: "/mst_2/chunk", query: { seq: "1", data: "vim" } });
    const commitRes = await sync.handle({ method: "GET", path: "/mst_2/commit" });

    expect(JSON.parse(commitRes.body)).toMatchObject({ ok: true, committed: 2 });
    const commit = calls.find((c) => c.pathname === "/v1/profile/commit");
    expect(commit?.body.memories).toEqual(["likes tea", "uses vim"]);

    // buffer cleared after a successful commit
    const second = await sync.handle({ method: "GET", path: "/mst_2/commit" });
    expect(JSON.parse(second.body)).toMatchObject({ ok: false, error: "no_chunks" });
  });

  it("re-sending the same seq is idempotent (last write wins)", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch();
    const sync = createMemorySync({ ...baseOptions, store, fetch: fetchFn, randomToken: () => "mst_3" });
    await sync.issue({ externalId: "ext-1" });

    await sync.handle({ method: "GET", path: "/mst_3/chunk", query: { seq: "0", data: "first draft" } });
    await sync.handle({ method: "GET", path: "/mst_3/chunk", query: { seq: "0", data: "final fact" } });
    await sync.handle({ method: "GET", path: "/mst_3/commit" });

    const commit = calls.find((c) => c.pathname === "/v1/profile/commit");
    expect(commit?.body.memories).toEqual(["final fact"]);
  });

  it("commits memories appended directly in the URL path (GET /{token}/m/...)", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch();
    const sync = createMemorySync({ ...baseOptions, store, fetch: fetchFn, randomToken: () => "mst_path" });
    await sync.issue({ configureToken: "agent-token" });

    // single encoded blob with a newline (%0A) → two memories
    const res = await sync.handle({ method: "GET", path: "/mst_path/m/likes%20tea%0Abased%20in%20NYC" });
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, committed: 2 });
    expect(calls.find((c) => c.pathname === "/v1/profile/commit")?.body.memories).toEqual([
      "likes tea",
      "based in NYC",
    ]);
  });

  it("records the provider from a /from/{provider}/m/ route as the source", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch();
    const sync = createMemorySync({ ...baseOptions, store, fetch: fetchFn, randomToken: () => "mst_prov" });
    await sync.issue({ configureToken: "agent-token" });

    const chatgpt = await sync.handle({ method: "GET", path: "/mst_prov/from/chatgpt/m/likes%20tea" });
    expect(JSON.parse(chatgpt.body)).toMatchObject({ ok: true, committed: 1, source: "chatgpt" });

    const claude = await sync.handle({ method: "GET", path: "/mst_prov/from/claude/m/uses%20vim" });
    expect(JSON.parse(claude.body)).toMatchObject({ ok: true, committed: 1, source: "claude" });

    const committed = calls.filter((c) => c.pathname === "/v1/profile/commit");
    expect(committed).toHaveLength(2);
    expect(committed[0]?.body.memories).toEqual(["likes tea"]);
    expect(committed[1]?.body.memories).toEqual(["uses vim"]);
  });

  it("treats extra path segments after /m/ as separate memories", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch();
    const sync = createMemorySync({ ...baseOptions, store, fetch: fetchFn, randomToken: () => "mst_path2" });
    await sync.issue({ configureToken: "agent-token" });

    const res = await sync.handle({ method: "GET", path: "/mst_path2/m/uses%20vim/lives%20in%20Berlin" });
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, committed: 2 });
    expect(calls.find((c) => c.pathname === "/v1/profile/commit")?.body.memories).toEqual([
      "uses vim",
      "lives in Berlin",
    ]);
  });

  it("routes a real path-fetch through the fetch handler", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch();
    const sync = createMemorySync({ ...baseOptions, store, fetch: fetchFn, randomToken: () => "mst_path3", basePath: "/sync" });
    await sync.issue({ configureToken: "agent-token" });

    const request = new Request("https://sign-in.me/sync/mst_path3/m/likes%20tea");
    const response = await sync.fetchHandler(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, committed: 1 });
    expect(calls.find((c) => c.pathname === "/v1/profile/commit")?.body.memories).toEqual(["likes tea"]);
  });

  it("supports a single-shot GET ingest?data=", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch();
    const sync = createMemorySync({ ...baseOptions, store, fetch: fetchFn, randomToken: () => "mst_4" });
    await sync.issue({ externalId: "ext-1" });

    const res = await sync.handle({ method: "GET", path: "/mst_4/ingest", query: { data: "solo fact" } });
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, committed: 1 });
    expect(calls.find((c) => c.pathname === "/v1/profile/commit")?.body.memories).toEqual(["solo fact"]);
  });

  it("rejects unknown and expired tokens", async () => {
    const store = localMemorySyncStore();
    const { fetchFn } = captureFetch();
    const sync = createMemorySync({
      ...baseOptions,
      store,
      fetch: fetchFn,
      randomToken: () => "mst_5",
      tokenTtlMs: 1000,
      now: (() => {
        let t = Date.parse("2026-07-27T00:00:00.000Z");
        return () => new Date((t += 5000)); // each call advances 5s -> token expires
      })(),
    });
    await sync.issue({ externalId: "ext-1" });

    const unknown = await sync.handle({ method: "POST", path: "/nope/ingest", body: { memories: ["x"] } });
    expect(unknown.status).toBe(404);

    const expired = await sync.handle({ method: "POST", path: "/mst_5/ingest", body: { memories: ["x fact"] } });
    expect(expired.status).toBe(410);
  });

  it("serves llms.txt over the router", async () => {
    const sync = createMemorySync({ ...baseOptions, store: localMemorySyncStore() });
    const generic = await sync.handle({ method: "GET", path: "/llms.txt" });
    expect(generic.contentType).toContain("text/plain");
    expect(generic.body).toContain("Configure Memory Sync");
  });

  it("round-trips through the fetch handler", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch();
    const sync = createMemorySync({ ...baseOptions, store, fetch: fetchFn, randomToken: () => "mst_6", basePath: "/sync" });
    await sync.issue({ externalId: "ext-1" });

    const request = new Request("https://sign-in.me/sync/mst_6/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memories: ["fetch fact"] }),
    });
    const response = await sync.fetchHandler(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, committed: 1 });
    expect(calls.find((c) => c.pathname === "/v1/profile/commit")?.body.memories).toEqual(["fetch fact"]);
  });
});

describe("createMemorySync SSO flow", () => {
  it("builds a hosted quick-auth URL that returns to the sync callback", () => {
    const sync = createMemorySync({
      ...baseOptions,
      publishableKey: "pk_test",
      store: localMemorySyncStore(),
    });
    const url = new URL(sync.signInUrl({ returnTo: "https://sign-in.me/sync/complete", state: "s1" }));
    expect(url.origin).toBe("https://sign-in.me");
    expect(url.searchParams.get("return_to") ?? url.searchParams.get("returnTo")).toContain("/sync/complete");
  });

  it("exchanges a sign-in code for a token and mints a bound ticket", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch({
      "/v1/auth/sign-in/exchange": () => ({
        token: "agent-token-from-sso",
        user_id: "user-1",
        approved: true,
        agent: "test-agent",
      }),
    });
    const sync = createMemorySync({
      ...baseOptions,
      publishableKey: "pk_test",
      store,
      fetch: fetchFn,
      randomToken: () => "mst_sso",
    });

    const ticket = await sync.completeSignIn({ code: "code-123", source: "chatgpt" });
    expect(ticket.token).toBe("mst_sso");
    expect(calls.some((c) => c.pathname === "/v1/auth/sign-in/exchange")).toBe(true);

    // the minted token is bound to the SSO-issued Configure token
    const record = await store.getSyncToken("mst_sso");
    expect(record?.configureToken).toBe("agent-token-from-sso");
  });

  it("validates a directly supplied token instead of a code", async () => {
    const store = localMemorySyncStore();
    const { fetchFn, calls } = captureFetch({
      "/v1/auth/sign-in/validate": () => ({ valid: true, approved: true, token_use: "agent", agent: "test-agent" }),
    });
    const sync = createMemorySync({
      ...baseOptions,
      publishableKey: "pk_test",
      store,
      fetch: fetchFn,
      randomToken: () => "mst_tok",
    });

    const ticket = await sync.completeSignIn({ token: "agent-token-direct" });
    expect(ticket.token).toBe("mst_tok");
    expect(calls.some((c) => c.pathname === "/v1/auth/sign-in/validate")).toBe(true);
    expect((await store.getSyncToken("mst_tok"))?.configureToken).toBe("agent-token-direct");
  });
});
