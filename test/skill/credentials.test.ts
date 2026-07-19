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
