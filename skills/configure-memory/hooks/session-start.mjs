#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { findConfigureCredentials } from "../engine/credentials.mjs";
import { callTool } from "../engine/mcp-client.mjs";
import { composeDigest } from "../engine/digest.mjs";

const NUDGE =
  'Configure is connected but the profile digest could not be fetched. Before your first substantive reply, call configure_profile_read once. As you learn durable user preferences, silently configure_profile_remember them into box "dev-preferences".';

const EXPIRED_NUDGE =
  'The stored Configure connection token has expired, so the profile digest could not be fetched and configure_* tool calls will fail with an authorization error until the user reconnects. Tell the user once, early: "Your Configure connection expired - run /mcp and reconnect configure." After they reconnect, call configure_profile_read once and follow the usual doctrine.';

export async function buildContext({ findCreds = findConfigureCredentials, call = callTool, now = Date.now } = {}) {
  const creds = findCreds();
  if (!creds) return null; // Configure not set up here — stay silent.
  // A known-dead token gets the specific nudge without a doomed network
  // round-trip. The hook never refreshes: Configure rotates refresh tokens
  // with reuse detection, so a second refreshing client (this hook beside
  // Claude Code itself) would revoke the whole token family.
  if (typeof creds.expiresAt === "number" && creds.expiresAt <= now()) {
    return EXPIRED_NUDGE;
  }
  try {
    const profile = await call({ ...creds, name: "configure_profile_read", args: {}, timeoutMs: 2000 });
    const readBox = async (box) => {
      try {
        return await call({ ...creds, name: "configure_profile_read", args: { box }, timeoutMs: 2000 });
      } catch {
        return null;
      }
    };
    // Own namespace only: agent writes live there as testimony. Category-box
    // reads (e.g. "dev-preferences") return judged canonical facts, which MCP
    // writes never reach today — reading them here is a guaranteed miss.
    const own = profile?.self?.id ? await readBox(profile.self.id) : null;
    const facts = own?.facts || own?.memories || own?.top_facts || own?.entries || [];
    return composeDigest(profile, facts.length ? { facts } : null) ?? NUDGE;
  } catch (err) {
    // A live 401 means the token died since the store recorded it: name the
    // real problem so the agent tells the user to reconnect instead of
    // retrying into the same wall.
    if (/HTTP 401\b/.test(String(err && err.message))) return EXPIRED_NUDGE;
    return NUDGE;
  }
}

async function main() {
  const guard = new Promise((r) => setTimeout(() => r(NUDGE), 4500));
  let context = null;
  try {
    context = await Promise.race([buildContext(), guard]);
  } catch {}
  if (!context) process.exit(0);
  // Exit in the write callback: process.exit() does not flush pending pipe
  // writes, which truncates the hook payload.
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }),
    () => process.exit(0)
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
