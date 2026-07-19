import { describe, it, expect, vi } from "vitest";
import { buildContext } from "../../skills/configure-memory/hooks/session-start.mjs";

describe("buildContext", () => {
  it("returns null when no credentials found", async () => {
    expect(await buildContext({ findCreds: () => null, call: vi.fn() })).toBeNull();
  });
  it("returns digest on success (profile + dev box)", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ identity: { name: "M" }, self: { id: "agents/x", memory_count: 1 }, boxes: [], sources: [] })
      .mockResolvedValueOnce({ facts: [{ text: "pnpm" }] });
    const out = await buildContext({ findCreds: () => ({ accessToken: "t", serverUrl: "u" }), call });
    expect(out).toContain("CONFIGURE DIGEST");
    expect(out).toContain("pnpm");
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
