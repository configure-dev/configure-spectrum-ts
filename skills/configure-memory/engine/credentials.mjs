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
    const isConfigureOrigin = (url) => {
      try { return new URL(url).origin === DEFAULT_URL; } catch { return false; }
    };
    const hit = entries.find(
      (e) => e.serverName === "configure" || isConfigureOrigin(e.serverUrl)
    );
    if (!hit?.accessToken) return null;
    return {
      accessToken: hit.accessToken,
      serverUrl: hit.serverUrl || DEFAULT_URL,
      // Expiry, when the store records it: lets the hook name the real
      // problem (expired token) instead of a generic fetch failure. The hook
      // NEVER uses the refresh grant: Configure rotates refresh tokens with
      // reuse detection (60s grace), so a second client refreshing would
      // revoke Claude Code's whole token family and force a re-auth loop.
      ...(typeof hit.expiresAt === "number" ? { expiresAt: hit.expiresAt } : {}),
    };
  } catch {
    return null;
  }
}
