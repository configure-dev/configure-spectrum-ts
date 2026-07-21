import { describe, it, expect, vi } from "vitest";
import { buildContext } from "../../skills/configure-memory/hooks/session-start.mjs";

describe("buildContext", () => {
  it("returns null when no credentials found", async () => {
    expect(await buildContext({ findCreds: () => null, call: vi.fn() })).toBeNull();
  });
  it("returns digest on success, reading own-namespace notes only (category boxes are judged-only)", async () => {
    const call = vi
      .fn()
      .mockImplementation(async ({ args }: any) => {
        if (!args?.box)
          return { identity: { name: "M" }, self: { id: "agents/x", memory_count: 1 }, boxes: [], sources: [] };
        if (args.box === "agents/x") return { memories: [{ text: "own-box fact" }] };
        throw new Error(`unexpected box ${args.box}`);
      });
    const out = await buildContext({ findCreds: () => ({ accessToken: "t", serverUrl: "u" }), call });
    expect(out).toContain("CONFIGURE DIGEST");
    expect(out).toContain("own-box fact");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("still returns digest when dev box read fails", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ identity: { name: "M" }, boxes: [], sources: [] })
      .mockRejectedValueOnce(new Error("boom"));
    const out = await buildContext({ findCreds: () => ({ accessToken: "t", serverUrl: "u" }), call });
    expect(out).toContain("CONFIGURE DIGEST");
  });
  it("returns the nudge when profile read fails", async () => {
    const call = vi.fn().mockRejectedValue(new Error("timeout"));
    const out = await buildContext({ findCreds: () => ({ accessToken: "t", serverUrl: "u" }), call });
    expect(out).toMatch(/configure_profile_read/);
  });
});

describe("token refresh in the hook", () => {
  const baseCreds = {
    accessToken: "stale", serverUrl: "https://mcp.configure.dev",
    refreshToken: "rt_1", clientId: "client_1", tokenUrl: "https://api.configure.dev/oauth/token",
  };
  const profile = { self: { id: "agents/claude-code" } };

  it("retries once with a fresh token after a 401", async () => {
    const tokensSeen: string[] = [];
    const call = async ({ accessToken, args }: any) => {
      tokensSeen.push(accessToken);
      if (accessToken === "stale") throw new Error("tools/call HTTP 401");
      return args?.box ? { facts: [] } : profile;
    };
    const refresh = async () => ({ accessToken: "fresh" });
    const ctx = await buildContext({ findCreds: () => ({ ...baseCreds }), call: call as any, refresh: refresh as any });
    expect(tokensSeen[0]).toBe("stale");
    expect(tokensSeen.slice(1).every(t => t === "fresh")).toBe(true);
    expect(typeof ctx).toBe("string");
    expect(ctx).not.toContain("could not be fetched");
  });

  it("preflight-refreshes when expiresAt is already past", async () => {
    const tokensSeen: string[] = [];
    const call = async ({ accessToken, args }: any) => {
      tokensSeen.push(accessToken);
      return args?.box ? { facts: [] } : profile;
    };
    const refresh = async () => ({ accessToken: "fresh" });
    await buildContext({
      findCreds: () => ({ ...baseCreds, expiresAt: Date.now() - 1000 }),
      call: call as any,
      refresh: refresh as any,
    });
    expect(tokensSeen[0]).toBe("fresh");
  });

  it("falls back to the nudge when refresh fails on a 401", async () => {
    const call = async () => { throw new Error("initialize HTTP 401"); };
    const refresh = async () => null;
    const ctx = await buildContext({ findCreds: () => ({ ...baseCreds }), call: call as any, refresh: refresh as any });
    expect(ctx).toContain("call configure_profile_read once");
  });

  it("does not attempt refresh without a refresh token (non-401 errors untouched)", async () => {
    let refreshCalls = 0;
    const call = async () => { throw new Error("tools/call HTTP 500"); };
    const refresh = async () => { refreshCalls += 1; return { accessToken: "x" }; };
    const ctx = await buildContext({
      findCreds: () => ({ accessToken: "tok", serverUrl: "https://mcp.configure.dev" }),
      call: call as any,
      refresh: refresh as any,
    });
    expect(refreshCalls).toBe(0);
    expect(ctx).toContain("call configure_profile_read once");
  });
});
