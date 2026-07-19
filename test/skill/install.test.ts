import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, uninstall, HOOK_MATCHER } from "../../skills/configure-memory/install.mjs";

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "cm-home-"));
  mkdirSync(join(home, ".claude", "skills", "configure-memory"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "configure-memory", "SKILL.md"), "v1");
  return home;
}

describe("install", () => {
  it("copies the skill, backs up v1, registers the hook once", () => {
    const home = fakeHome();
    install({ home });
    const skills = join(home, ".claude", "skills");
    expect(readFileSync(join(skills, "configure-memory", "SKILL.md"), "utf8")).toContain("always-write");
    expect(readFileSync(join(skills, "configure-memory.v1.bak", "SKILL.md"), "utf8")).toBe("v1");
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const entries = settings.hooks.SessionStart.filter((e: any) => e.matcher === HOOK_MATCHER);
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks[0].command).toContain("session-start.mjs");
    install({ home }); // idempotent
    const again = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(again.hooks.SessionStart.filter((e: any) => e.matcher === HOOK_MATCHER)).toHaveLength(1);
  });
  it("preserves unrelated hooks and settings", () => {
    const home = fakeHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        model: "opus",
        hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "other.sh" }] }] },
      })
    );
    install({ home });
    const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(s.model).toBe("opus");
    expect(s.hooks.SessionStart.some((e: any) => e.hooks[0].command === "other.sh")).toBe(true);
  });
  it("uninstall removes only our hook entry", () => {
    const home = fakeHome();
    install({ home });
    uninstall({ home });
    const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect((s.hooks.SessionStart ?? []).filter((e: any) => e.matcher === HOOK_MATCHER)).toHaveLength(0);
    expect(existsSync(join(home, ".claude", "skills", "configure-memory", "SKILL.md"))).toBe(true);
  });
});
