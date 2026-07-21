// Minimal MCP streamable-HTTP client: initialize -> initialized -> tools/call.
export async function callTool({ serverUrl, accessToken, name, args = {}, fetchImpl = fetch, timeoutMs = 4000 }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const base = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
  };
  const post = (body, extra = {}) =>
    fetchImpl(serverUrl, { method: "POST", headers: { ...base, ...extra }, body: JSON.stringify(body), signal });

  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "configure-memory-hook", version: "2.1.0" },
    },
  });
  if (!init.ok) throw new Error(`initialize HTTP ${init.status}`);
  const sid = init.headers.get("mcp-session-id");
  await parseRpc(init);
  const sess = sid ? { "mcp-session-id": sid } : {};
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sess).catch(() => {});

  const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, sess);
  if (!res.ok) throw new Error(`tools/call HTTP ${res.status}`);
  const rpc = await parseRpc(res);
  if (rpc.error) throw new Error(`rpc ${rpc.error.code}: ${rpc.error.message}`);
  const text = rpc.result?.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) return rpc.result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function parseRpc(res) {
  const ct = res.headers.get("content-type") || "";
  const body = await res.text();
  if (ct.includes("text/event-stream")) {
    const datas = body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(datas[i]);
        if (j.result !== undefined || j.error !== undefined) return j;
      } catch {}
    }
    return {};
  }
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}
