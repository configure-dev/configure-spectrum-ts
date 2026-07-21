import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "https://mcp.configure.dev";
const DEFAULT_TOKEN_URL = "https://api.configure.dev/oauth/token";

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
    return {
      accessToken: hit.accessToken,
      serverUrl: hit.serverUrl || DEFAULT_URL,
      // Refresh material, when the store carries it. Used in-memory only:
      // the hook never writes the store — Claude Code owns its own refresh.
      ...(hit.refreshToken ? { refreshToken: hit.refreshToken } : {}),
      ...(hit.clientId ? { clientId: hit.clientId } : {}),
      ...(typeof hit.expiresAt === "number" ? { expiresAt: hit.expiresAt } : {}),
      tokenUrl: hit.tokenUrl || DEFAULT_TOKEN_URL,
    };
  } catch {
    return null;
  }
}

/** Mint a fresh access token from the stored refresh token. In-memory only;
 *  returns null on ANY failure (fail soft — the caller falls back to the
 *  nudge, never blocks the session). */
export async function refreshAccessToken({ refreshToken, clientId, tokenUrl = DEFAULT_TOKEN_URL, serverUrl = DEFAULT_URL, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (!refreshToken || !clientId) return null;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      // RFC 8707: keep the refreshed token on the MCP audience.
      resource: serverUrl,
    });
    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json.access_token === "string" && json.access_token ? { accessToken: json.access_token } : null;
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
