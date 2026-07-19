import { describe, it, expect } from "vitest";
import { composeDigest, CAP_CHARS } from "../../skills/configure-memory/engine/digest.mjs";

const profile = {
  identity: { name: "Manuel David", role: "software engineer", company: "Paradigm", email: "m@x.dev" },
  self: { id: "agents/mcp-abc", memory_count: 3 },
  boxes: [
    { id: "dev-preferences", count: 4 },
    { id: "work", count: 5 },
  ],
  sources: [
    { id: "agents/claude-code", count: 31 },
    { id: "imports/chatgpt", count: 79 },
  ],
  changesSince: { memories: [{ text: "newest fact", date: "2026-07-19" }, { text: "older" }] },
};
const devBox = { facts: [{ text: "Prefers pnpm everywhere" }, { text: "Strict TypeScript always" }] };

describe("composeDigest", () => {
  it("includes header, identity, self namespace, dev prefs, TOC, changes, doctrine", () => {
    const d = composeDigest(profile, devBox)!;
    expect(d).toContain("CONFIGURE DIGEST");
    expect(d).toContain("Manuel David");
    expect(d).toContain("agents/mcp-abc");
    expect(d).toContain("Prefers pnpm everywhere");
    expect(d).toContain("dev-preferences(4)");
    expect(d).toContain("agents/claude-code(31)");
    expect(d).toContain("2 newer");
    expect(d).toContain("dev-preferences");
    expect(d).toContain("configure_profile_search");
  });
  it("accepts alternate box shapes (memories / top_facts) and missing box", () => {
    expect(composeDigest(profile, { memories: [{ text: "alt" }] })).toContain("alt");
    expect(composeDigest(profile, null)).toContain("CONFIGURE DIGEST");
  });
  it("caps at CAP_CHARS", () => {
    const big = { ...profile, boxes: Array.from({ length: 400 }, (_, i) => ({ id: `box-${i}`, count: i })) };
    expect(composeDigest(big, devBox)!.length).toBeLessThanOrEqual(CAP_CHARS);
  });
  it("returns null without a profile", () => {
    expect(composeDigest(null, devBox)).toBeNull();
  });
});
