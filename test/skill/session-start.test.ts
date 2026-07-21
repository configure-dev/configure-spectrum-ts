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

describe("expired-token handling in the hook", () => {
  const baseCreds = { accessToken: "tok", serverUrl: "https://mcp.configure.dev" };

  it("returns the expired nudge without a network call when expiresAt is past", async () => {
    let calls = 0;
    const call = async () => { calls += 1; return {}; };
    const ctx = await buildContext({
      findCreds: () => ({ ...baseCreds, expiresAt: 1000 }),
      call: call as any,
      now: () => 2000,
    });
    expect(calls).toBe(0);
    expect(ctx).toContain("connection expired");
    expect(ctx).toContain("/mcp");
  });

  it("returns the expired nudge on a live 401", async () => {
    const call = async () => { throw new Error("tools/call HTTP 401"); };
    const ctx = await buildContext({ findCreds: () => ({ ...baseCreds }), call: call as any });
    expect(ctx).toContain("connection expired");
  });

  it("keeps the generic nudge for non-401 failures", async () => {
    const call = async () => { throw new Error("tools/call HTTP 500"); };
    const ctx = await buildContext({ findCreds: () => ({ ...baseCreds }), call: call as any });
    expect(ctx).toContain("could not be fetched");
    expect(ctx).not.toContain("connection expired");
  });

  it("a future expiresAt proceeds normally", async () => {
    const call = async ({ args }: any) => (args?.box ? { facts: [] } : { self: { id: "agents/claude-code" } });
    const ctx = await buildContext({
      findCreds: () => ({ ...baseCreds, expiresAt: Date.now() + 60_000 }),
      call: call as any,
    });
    expect(typeof ctx).toBe("string");
    expect(ctx).not.toContain("expired");
  });
});
