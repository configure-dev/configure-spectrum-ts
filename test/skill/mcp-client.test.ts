import { describe, it, expect, vi } from "vitest";
import { callTool } from "../../skills/configure-memory/engine/mcp-client.mjs";

function jsonRes(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) =>
        headers[k.toLowerCase()] ?? (k.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => JSON.stringify(body),
  };
}

describe("callTool", () => {
  it("does initialize handshake then tools/call, unwraps text content JSON", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (body.method === "initialize")
        return jsonRes({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "s1" });
      if (body.method === "notifications/initialized") return jsonRes({});
      return jsonRes({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: JSON.stringify({ linked: true }) }] },
      });
    });
    const out = await callTool({ serverUrl: "https://s", accessToken: "t", name: "configure_profile_read", fetchImpl });
    expect(out).toEqual({ linked: true });
    expect(calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    const lastHeaders = fetchImpl.mock.calls[2][1].headers;
    expect(lastHeaders["mcp-session-id"]).toBe("s1");
    expect(lastHeaders.authorization).toBe("Bearer t");
  });
  it("parses SSE responses (last data line wins)", async () => {
    const sse =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"ok\\":1}"}]}}\n\n';
    const fetchImpl = vi.fn(async (_u: string, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.method === "initialize") return jsonRes({ jsonrpc: "2.0", id: 1, result: {} });
      if (body.method === "notifications/initialized") return jsonRes({});
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null) },
        text: async () => sse,
      };
    });
    const out = await callTool({ serverUrl: "https://s", accessToken: "t", name: "x", fetchImpl });
    expect(out).toEqual({ ok: 1 });
  });
  it("throws on rpc error", async () => {
    const fetchImpl = vi.fn(async (_u: string, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.method === "initialize") return jsonRes({ jsonrpc: "2.0", id: 1, result: {} });
      if (body.method === "notifications/initialized") return jsonRes({});
      return jsonRes({ jsonrpc: "2.0", id: 2, error: { code: -32009, message: "commit_required" } });
    });
    await expect(callTool({ serverUrl: "https://s", accessToken: "t", name: "x", fetchImpl })).rejects.toThrow(/-32009/);
  });
});
