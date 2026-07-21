import { describe, it, expect } from "vitest";
import { findConfigureCredentials, refreshAccessToken } from "../../skills/configure-memory/engine/credentials.mjs";

const dump = JSON.stringify({
  mcpOAuth: {
    "supabase|59e49": { serverName: "supabase", serverUrl: "https://x", accessToken: "nope" },
    "configure|ab12": { serverName: "configure", serverUrl: "https://mcp.configure.dev", accessToken: "tok_123" },
  },
});

describe("findConfigureCredentials", () => {
  it("prefers CONFIGURE_TOKEN env override", () => {
    const c = findConfigureCredentials({ env: { CONFIGURE_TOKEN: "envtok" }, keychainDump: dump });
    expect(c).toEqual({ accessToken: "envtok", serverUrl: "https://mcp.configure.dev" });
  });
  it("finds the configure entry in a keychain dump", () => {
    const c = findConfigureCredentials({ env: {}, keychainDump: dump });
    expect(c?.accessToken).toBe("tok_123");
    expect(c?.serverUrl).toBe("https://mcp.configure.dev");
  });
  it("matches by serverUrl when serverName differs", () => {
    const d = JSON.stringify({ mcpOAuth: { "x|1": { serverName: "cfg", serverUrl: "https://mcp.configure.dev/mcp", accessToken: "t2" } } });
    expect(findConfigureCredentials({ env: {}, keychainDump: d })?.accessToken).toBe("t2");
  });
  it("returns null on no match / bad JSON / null dump", () => {
    expect(findConfigureCredentials({ env: {}, keychainDump: "{}" })).toBeNull();
    expect(findConfigureCredentials({ env: {}, keychainDump: "not json" })).toBeNull();
    expect(findConfigureCredentials({ env: {}, keychainDump: null })).toBeNull();
  });
});

describe("refresh material", () => {
  it("carries refreshToken/clientId/expiresAt/tokenUrl from the store", () => {
    const d = JSON.stringify({ mcpOAuth: { "configure|1": {
      serverName: "configure", serverUrl: "https://mcp.configure.dev",
      accessToken: "tok", refreshToken: "rt_1", clientId: "client_1", expiresAt: 1753000000000,
    } } });
    const c = findConfigureCredentials({ env: {}, keychainDump: d });
    expect(c?.refreshToken).toBe("rt_1");
    expect(c?.clientId).toBe("client_1");
    expect(c?.expiresAt).toBe(1753000000000);
    expect(c?.tokenUrl).toBe("https://api.configure.dev/oauth/token");
  });
});

describe("refreshAccessToken", () => {
  it("posts a form-encoded refresh grant with the MCP resource and returns the new token", async () => {
    let captured: { url?: string; body?: string; contentType?: string } = {};
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), body: String(init.body), contentType: init.headers["content-type"] };
      return { ok: true, json: async () => ({ access_token: "fresh_tok" }) };
    }) as any;
    const out = await refreshAccessToken({ refreshToken: "rt_1", clientId: "client_1", fetchImpl });
    expect(out).toEqual({ accessToken: "fresh_tok" });
    expect(captured.url).toBe("https://api.configure.dev/oauth/token");
    expect(captured.contentType).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(captured.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt_1");
    expect(params.get("client_id")).toBe("client_1");
    expect(params.get("resource")).toBe("https://mcp.configure.dev");
  });
  it("fails soft: null on HTTP error, thrown fetch, missing token, or missing material", async () => {
    expect(await refreshAccessToken({ refreshToken: "rt", clientId: "c", fetchImpl: (async () => ({ ok: false })) as any })).toBeNull();
    expect(await refreshAccessToken({ refreshToken: "rt", clientId: "c", fetchImpl: (async () => { throw new Error("net"); }) as any })).toBeNull();
    expect(await refreshAccessToken({ refreshToken: "rt", clientId: "c", fetchImpl: (async () => ({ ok: true, json: async () => ({}) })) as any })).toBeNull();
    expect(await refreshAccessToken({ clientId: "c" } as any)).toBeNull();
  });
});
