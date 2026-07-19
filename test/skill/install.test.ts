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
    expect(readFileSync(join(home, ".claude", "skill-backups", "configure-memory.v1", "SKILL.md"), "utf8")).toBe("v1");
    expect(existsSync(join(skills, "configure-memory.v1.bak"))).toBe(false);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const entries = settings.hooks.SessionStart.filter((e: any) => e.matcher === HOOK_MATCHER);
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks[0].command).toContain("session-start.mjs");
    install({ home }); // idempotent
    const again = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(again.hooks.SessionStart.filter((e: any) => e.matcher === HOOK_MATCHER)).toHaveLength(1);
  });
  it("allows read/search/remember/commit but not forget/import; fires on clear", () => {
    const home = fakeHome();
    install({ home });
    const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(s.hooks.SessionStart[0].matcher).toContain("clear");
    expect(s.permissions.allow).toContain("mcp__configure__configure_profile_remember");
    expect(s.permissions.allow).toContain("mcp__configure__configure_profile_commit");
    expect(s.permissions.allow).not.toContain("mcp__configure__configure_profile_forget");
    expect(s.permissions.allow).not.toContain("mcp__configure__configure_profile_import");
  });
  it("detects v2 by version frontmatter, not a doctrine phrase (no backup on reinstall)", () => {
    const home = fakeHome();
    install({ home }); // v1 present -> backed up
    expect(existsSync(join(home, ".claude", "skill-backups", "configure-memory.v1"))).toBe(true);
    // installed skill carries version: 2.x -> a second install makes no new backup
    const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(s)); // compact
    install({ home });
    expect(existsSync(join(home, ".claude", "skill-backups", "configure-memory.v1.1"))).toBe(false);
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
  it("aborts cleanly on malformed settings.json without copying the skill", () => {
    const home = fakeHome();
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
    expect(() => install({ home })).toThrow(/not valid JSON/);
    expect(readFileSync(join(home, ".claude", "skills", "configure-memory", "SKILL.md"), "utf8")).toBe("v1");
  });
  it("aborts on wrong-shaped hooks.SessionStart without copying the skill", () => {
    const home = fakeHome();
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: "oops" } }));
    expect(() => install({ home })).toThrow(/must be an array/);
    expect(readFileSync(join(home, ".claude", "skills", "configure-memory", "SKILL.md"), "utf8")).toBe("v1");
  });
  it("aborts on non-object permissions without half-installing", () => {
    const home = fakeHome();
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: "all" }));
    expect(() => install({ home })).toThrow(/permissions.*must be an object/);
    expect(readFileSync(join(home, ".claude", "skills", "configure-memory", "SKILL.md"), "utf8")).toBe("v1");
  });
  it("appends to an existing permissions.allow, preserving prior entries", () => {
    const home = fakeHome();
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    install({ home });
    const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(s.permissions.allow).toContain("Bash(ls)");
    expect(s.permissions.allow).toContain("mcp__configure__configure_profile_read");
  });
  it("rewrites when the hook is already present but permissions are missing", () => {
    const home = fakeHome();
    install({ home });
    const settingsPath = join(home, ".claude", "settings.json");
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    delete s.permissions; // hook stays, permissions stripped
    writeFileSync(settingsPath, JSON.stringify(s));
    install({ home });
    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.permissions.allow).toContain("mcp__configure__configure_profile_remember");
    expect(after.hooks.SessionStart.filter((e: any) => e.matcher === HOOK_MATCHER)).toHaveLength(1);
  });
  it("no-op reinstall does not rewrite settings.json, and evals/scripts are not installed", () => {
    const home = fakeHome();
    install({ home });
    const settingsPath = join(home, ".claude", "settings.json");
    const compact = JSON.stringify(JSON.parse(readFileSync(settingsPath, "utf8")));
    writeFileSync(settingsPath, compact); // user's own formatting
    install({ home });
    expect(readFileSync(settingsPath, "utf8")).toBe(compact);
    expect(existsSync(join(home, ".claude", "skills", "configure-memory", "evals"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "configure-memory", "scripts"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "configure-memory", "formats"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "configure-memory", "engine"))).toBe(true);
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
