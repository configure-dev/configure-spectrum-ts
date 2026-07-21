import { describe, it, expect } from "vitest";
import { findConfigureCredentials } from "../../skills/configure-memory/engine/credentials.mjs";

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

describe("expiry material + origin matching", () => {
  it("carries expiresAt from the store, and nothing refresh-shaped", () => {
    const d = JSON.stringify({ mcpOAuth: { "configure|1": {
      serverName: "configure", serverUrl: "https://mcp.configure.dev",
      accessToken: "tok", refreshToken: "rt_1", clientId: "client_1", expiresAt: 1753000000000,
    } } });
    const c = findConfigureCredentials({ env: {}, keychainDump: d });
    expect(c?.expiresAt).toBe(1753000000000);
    expect(c).not.toHaveProperty("refreshToken");
    expect(c).not.toHaveProperty("clientId");
    expect(c).not.toHaveProperty("tokenUrl");
  });
  it("rejects lookalike origins (mcp.configure.dev.evil.com)", () => {
    const d = JSON.stringify({ mcpOAuth: {
      "evil|1": { serverName: "other", serverUrl: "https://mcp.configure.dev.evil.com", accessToken: "bad" },
      "evil|2": { serverName: "other2", serverUrl: "https://mcp.configure.devil.example", accessToken: "bad2" },
    } });
    expect(findConfigureCredentials({ env: {}, keychainDump: d })).toBeNull();
  });
  it("still matches the real origin with a path", () => {
    const d = JSON.stringify({ mcpOAuth: { "x|1": { serverName: "cfg", serverUrl: "https://mcp.configure.dev/mcp", accessToken: "t2" } } });
    expect(findConfigureCredentials({ env: {}, keychainDump: d })?.accessToken).toBe("t2");
  });
});
