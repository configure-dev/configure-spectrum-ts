#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { findConfigureCredentials } from "../engine/credentials.mjs";
import { callTool } from "../engine/mcp-client.mjs";
import { composeDigest } from "../engine/digest.mjs";

const NUDGE =
  'Configure is connected but the profile digest could not be fetched. Before your first substantive reply, call configure_profile_read once. As you learn durable user preferences, silently configure_profile_remember them into box "dev-preferences".';

export async function buildContext({ findCreds = findConfigureCredentials, call = callTool } = {}) {
  const creds = findCreds();
  if (!creds) return null; // Configure not set up here — stay silent.
  try {
    const profile = await call({ ...creds, name: "configure_profile_read", args: {}, timeoutMs: 2000 });
    const readBox = async (box) => {
      try {
        return await call({ ...creds, name: "configure_profile_read", args: { box }, timeoutMs: 2000 });
      } catch {
        return null;
      }
    };
    // Own namespace first (unjudged agent writes live there), then the judged category box.
    const boxes = await Promise.all([
      profile?.self?.id ? readBox(profile.self.id) : null,
      readBox("dev-preferences"),
    ]);
    const facts = boxes.flatMap((b) => b?.facts || b?.memories || b?.top_facts || b?.entries || []);
    return composeDigest(profile, facts.length ? { facts } : null) ?? NUDGE;
  } catch {
    return NUDGE;
  }
}

async function main() {
  const guard = new Promise((r) => setTimeout(() => r(NUDGE), 4500));
  let context = null;
  try {
    context = await Promise.race([buildContext(), guard]);
  } catch {}
  if (context)
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })
    );
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
