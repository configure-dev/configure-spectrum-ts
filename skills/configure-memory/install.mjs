#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
export const HOOK_MATCHER = "startup|resume|compact";

export function install({ home = homedir() } = {}) {
  // Parse settings BEFORE touching the skills dir: a malformed settings.json
  // must abort cleanly, not leave a half-install (skill copied, hook missing).
  const settingsPath = join(home, ".claude", "settings.json");
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (e) {
      throw new Error(
        `~/.claude/settings.json is not valid JSON (${e.message}). Fix it and re-run; nothing was installed.`
      );
    }
  }
  if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error('~/.claude/settings.json: "hooks" must be an object. Fix it and re-run; nothing was installed.');
  }
  if (settings.hooks?.SessionStart !== undefined && !Array.isArray(settings.hooks.SessionStart)) {
    throw new Error('~/.claude/settings.json: "hooks.SessionStart" must be an array. Fix it and re-run; nothing was installed.');
  }

  const skillsDir = join(home, ".claude", "skills");
  const dest = join(skillsDir, "configure-memory");
  mkdirSync(skillsDir, { recursive: true });
  if (existsSync(dest) && !isV2(dest)) {
    // Backup must live OUTSIDE ~/.claude/skills — a SKILL.md in any child dir
    // there is picked up as a live (competing) skill.
    const bakDir = join(home, ".claude", "skill-backups");
    mkdirSync(bakDir, { recursive: true });
    const bak = join(bakDir, "configure-memory.v1");
    if (!existsSync(bak)) renameSync(dest, bak);
  }
  // evals/ carries captured-profile fixtures and scripts/ is build tooling —
  // neither belongs on user machines.
  cpSync(SRC, dest, {
    recursive: true,
    filter: (s) => !/node_modules|[\\/](evals|scripts)([\\/]|$)/.test(s),
  });
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const command = `node "${join(dest, "hooks", "session-start.mjs")}"`;
  // Match on the command alone so a future HOOK_MATCHER change cannot stack a
  // duplicate hook entry. Skip the write when nothing changed (no-op
  // reinstalls must not churn the user's settings formatting).
  const mine = settings.hooks.SessionStart.find((e) => e.hooks?.some((h) => h.command?.includes("session-start.mjs")));
  if (!mine) {
    settings.hooks.SessionStart.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command, timeout: 5 }] });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return { dest, settingsPath };
}

export function uninstall({ home = homedir() } = {}) {
  const settingsPath = join(home, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return;
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (e) {
    throw new Error(`~/.claude/settings.json is not valid JSON (${e.message}). Fix it and re-run --uninstall.`);
  }
  if (settings.hooks?.SessionStart)
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
      (e) => !(e.matcher === HOOK_MATCHER && e.hooks?.some((h) => h.command?.includes("session-start.mjs")))
    );
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function isV2(dir) {
  try {
    return readFileSync(join(dir, "SKILL.md"), "utf8").includes("always-write");
  } catch {
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--uninstall")) {
    uninstall({});
    console.log("configure-memory hooks removed");
  } else {
    const { dest } = install({});
    console.log(`configure-memory v2 installed at ${dest}; SessionStart hook registered`);
  }
}
