import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "https://mcp.configure.dev";

// Reuses Claude Code's own Configure OAuth token. Never mints credentials.
export function findConfigureCredentials({ env = process.env, keychainDump } = {}) {
  if (env.CONFIGURE_TOKEN) {
    return { accessToken: env.CONFIGURE_TOKEN, serverUrl: env.CONFIGURE_MCP_URL || DEFAULT_URL };
  }
  let raw = keychainDump;
  if (raw === undefined) raw = readAuthStore();
  if (!raw) return null;
  try {
    const entries = Object.values(JSON.parse(raw).mcpOAuth || {});
    const hit = entries.find(
      (e) => e.serverName === "configure" || (e.serverUrl || "").startsWith(DEFAULT_URL)
    );
    if (!hit?.accessToken) return null;
    return { accessToken: hit.accessToken, serverUrl: hit.serverUrl || DEFAULT_URL };
  } catch {
    return null;
  }
}

function readAuthStore() {
  try {
    return execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {}
  try {
    return readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
  } catch {}
  return null;
}
