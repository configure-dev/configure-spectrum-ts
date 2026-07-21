# configure-memory v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the always-write doctrine as a Claude Code skill + read-only SessionStart hook engine + portable formats (AGENTS.md block, docs/llms.txt page), with an in-agent eval harness proving invocation rates.

**Architecture:** Everything is developed in-repo under `skills/configure-memory/` (versioned, reviewable), then installed by `install.mjs` which copies to `~/.claude/skills/configure-memory` (backing up v1) and idempotently registers a SessionStart hook in `~/.claude/settings.json`. The hook is a zero-dependency Node script chain: keychain credential discovery → minimal MCP streamable-HTTP client → digest composer (≤3200 chars ≈ 800 tokens) → `additionalContext` JSON. Fail-soft everywhere: no Configure creds → silent no-op; fetch fails → one-line nudge; never blocks session start. Evals run real `claude -p` sessions and count `mcp__configure__*` tool calls in stream-json output.

**Tech Stack:** Node ≥18 (built-in fetch), plain `.mjs` (zero deps), vitest (already in repo) for unit tests, `claude -p --output-format stream-json` for evals.

**Spec deviations (documented):** (1) The spec's two description variants collapse into one: the description conditions its session-start directive on no `CONFIGURE DIGEST` block being present, which is truthful in both hook-installed and hook-less configurations. (2) The privacy-leak grader is deferred to the post-ship eval round; the build-time evals cover invocation rates, pollution, and narration. (3) The spec's PreCompact nudge is dropped: PreCompact hook output is not injected into model context in Claude Code. The pre-compaction save/commit discipline lives in SKILL.md's commit-cadence rules, and post-compaction re-grounding is handled by the SessionStart hook's `compact` matcher.

**File structure:**

```
skills/configure-memory/
  SKILL.md                    # the doctrine (Claude Code format)
  README.md                   # what this is, install, formats
  install.mjs                 # copy to ~/.claude/skills + register hooks (idempotent, --uninstall)
  engine/credentials.mjs      # find Configure token from Claude Code's own auth store
  engine/mcp-client.mjs       # minimal MCP streamable-HTTP tools/call client
  engine/digest.mjs           # compose ≤3200-char digest from profile reads
  hooks/session-start.mjs     # SessionStart entrypoint (startup|resume|compact)
  formats/AGENTS-block.md     # drop-in block for Codex/Cursor/Devin/etc.
  formats/docs-page.md        # docs.configure.dev page draft + llms.txt section
  evals/scenarios.json        # should-fire / should-not-fire coding prompts
  evals/run.mjs               # claude -p runner, counts configure tool calls
test/skill/credentials.test.ts
test/skill/mcp-client.test.ts
test/skill/digest.test.ts
test/skill/session-start.test.ts
test/skill/install.test.ts
```

Out of this plan's scope (tracked, not built here): wiring the connect/import-flow nudge into memory-link, publishing the docs page to docs.configure.dev, judge pipeline (other session), any MCP surface changes (post-eval decision).

---

### Task 1: SKILL.md (the doctrine)

**Files:**
- Create: `skills/configure-memory/SKILL.md`

- [ ] **Step 1: Write SKILL.md with this exact content**

````markdown
---
name: configure-memory
description: >-
  The user's portable engineering memory (Configure MCP): who they are, their
  dev preferences, cross-repo lessons, and what their other AI agents learned.
  ALWAYS follow its doctrine in every coding session: if no "CONFIGURE DIGEST"
  block appears in your context, call configure_profile_read once before your
  first substantive reply. As you work, save durable user preferences and
  hard-won cross-repo lessons to the profile the moment they surface —
  silently, without asking. Do NOT pick a convention default (package manager,
  framework, test runner, formatter, commit/PR style), answer a question about
  the user, or claim something about them is "not on file" without
  configure_profile_search first. Also invoke on "remember this", "my usual",
  "like last time", "what do you know about me", "forget that", "save
  everything you know about me", and when scaffolding or setting up anything
  new. Repo conventions stay in CLAUDE.md; user-portable facts live here.
---

# Configure Memory — the always-write doctrine

The user has a portable memory profile served by the Configure MCP tools
(`configure_profile_read`, `configure_profile_search`,
`configure_profile_remember`, `configure_profile_commit`,
`configure_profile_forget`, `configure_profile_import`, `configure_connect`).
Every agent that works with this user gets better at serving them by reading
it and, above all, by WRITING to it as it learns. That is the doctrine: the
more you work with the user, the more you save; the next session — in any
agent, on any machine — starts smarter.

## The loop

1. **Ground.** A `CONFIGURE DIGEST` block in your context means the hook
   already loaded the profile — do not re-read at session start. No digest →
   call `configure_profile_read` once before your first substantive reply.
2. **Precheck.** Before any preference-sensitive decision — package manager,
   framework, test runner, formatter, linter, commit/PR style, scaffolding
   choices — `configure_profile_search` for the user's way. Never claim
   something about the user is "not on file" without searching first.
3. **Write as you learn.** The moment you learn something durable about the
   user, save it with `configure_profile_remember` into box
   `"dev-preferences"`. Silently: no "want me to save this?", no "saved to
   your profile" narration. One fact per call.
4. **Re-read at checkpoints.** After compaction (the digest reappears) and at
   long-session milestones, check what changed: your own box
   (`configure_profile_read {box: "<your self.id>"}`) and `changesSince`.
5. **Commit at milestones.** On task completion and before long pauses, call
   `configure_profile_commit` with an honest one-line summary. On error
   `-32009 commit_required`: commit immediately with a one-line summary, then
   retry the read. This error is normal in long sessions — it is never a
   reason to stop using the tools.

## Routing: where does a fact go?

| Fact | Destination |
|---|---|
| A teammate cloning the repo would need it | CLAUDE.md / AGENTS.md |
| This user would want it in a new repo, on a new machine, or in another agent | Configure (`dev-preferences`) |
| Nobody would want it next week / derivable from the codebase | Nowhere |

Margin cases: "this repo uses pnpm" → CLAUDE.md. "I prefer pnpm everywhere" →
Configure. "build is `make dev`" → CLAUDE.md. "I always want strict
TypeScript" → Configure. "src/auth.ts had a bug today" → nowhere. "user hit
the same Prisma connection-pool gotcha in two repos" → Configure, with date,
repo, and library version in the fact text.

## Write playbook

- **User-stated preferences**: save immediately, verbatim intent, one fact.
- **Inferred lessons** (recurring bugs, library gotchas, architecture
  decisions, style signals): save when they pass the rubric — *"will a future
  session in a different repo act differently because of this?"* Include
  date, repo, and version. Soft budget: ~5 inferred saves per session; prefer
  quality over volume.
- **Continuity pointer**: when finishing significant work in a repo, save ONE
  fact: `working on <repo>: <state>, next: <step> (<date>)`. Supersede the
  old pointer (save new; forget the previous one by id if it is yours).
- **Bulk export**: when the user says "save everything you know about me",
  distill the session's durable learnings and save them fact-by-fact (or
  `configure_profile_import` for a long-form dump).
- **Forget**: "forget that" → `configure_profile_forget` with the memory id
  and `reason: "user_request"`; confirm in one line (deletes are the one
  visible write). If the id belongs to an older token family and forget
  fails, say so plainly and point the user at their Configure profile page —
  never fail silently.

## Rules

- Never ask permission to save; never narrate routine saves or reads.
- One `configure_profile_read` per session (the digest counts as it).
- Read your own writes from your own box (`agents/<self.id>` from the digest
  or read result) or `configure_profile_search {source: <self>}` — not from
  category boxes.
- Never pass `user_id`/`agent`/identity arguments; identity comes from the
  session. Never construct sign-in links; `configure_connect` mints them.
- Configure MCP absent or unlinked: proceed with the task normally, suggest
  connecting once (`https://mcp.configure.dev`), do not improvise a memory
  substitute.
- User instructions always outrank this skill.

## Red flags — you are rationalizing if you think:

| Thought | Reality |
|---|---|
| "This task is impersonal, no need to check" | Convention choices are personal. Precheck. |
| "CLAUDE.md covers preferences" | CLAUDE.md is the repo's memory. The user's memory is Configure. |
| "I'll save the lessons at the end" | End-of-session never comes. Save at the moment of learning. |
| "Not worth a save, it's minor" | If it passes the rubric, save it. Minor facts compound. |
| "I remember the user from context" | Context dies with the session. The profile doesn't. |
| "The read failed, I'll skip memory this session" | Commit and retry on -32009; one failure is not a policy. |
````

- [ ] **Step 2: Commit**

```bash
git add skills/configure-memory/SKILL.md
git commit -m "feat(skill): configure-memory v2 SKILL.md — always-write doctrine"
```

---

### Task 2: Portable formats

**Files:**
- Create: `skills/configure-memory/formats/AGENTS-block.md`
- Create: `skills/configure-memory/formats/docs-page.md`

- [ ] **Step 1: Write `formats/AGENTS-block.md`**

````markdown
<!-- Configure memory doctrine — paste into AGENTS.md / system prompt of any
     coding agent connected to the Configure MCP (https://mcp.configure.dev) -->

## User memory (Configure) — always-write doctrine

The user has a portable memory profile on the Configure MCP. Using it well is
paramount to the user. The pattern:

1. At session start, call `configure_profile_read` once. It returns identity,
   dev preferences, and a table of contents of memory boxes.
2. Before any preference-sensitive decision (package manager, framework, test
   runner, formatter, commit/PR style, scaffolding), call
   `configure_profile_search` for the user's way. Never say something about
   the user is "not on file" without searching.
3. The moment you learn something durable about the user — a stated
   preference, a style signal, a cross-repo lesson (with date, repo, version)
   — save it with `configure_profile_remember` into box `"dev-preferences"`.
   Silently: do not ask permission, do not narrate saves.
4. Repo-specific facts belong in the repo's own docs (AGENTS.md/CLAUDE.md),
   not in Configure. Rule of thumb: if the user would want it in a new repo,
   a new machine, or a different agent, it goes to Configure.
5. On "forget that": `configure_profile_forget` with the memory id,
   `reason: "user_request"`, and confirm in one line.
6. On error `-32009`: call `configure_profile_commit` with a one-line
   summary, then retry. Never stop using the tools over one failure.
````

- [ ] **Step 2: Write `formats/docs-page.md`**

````markdown
# Make your coding agent remember you (docs.configure.dev draft)

Any coding agent connected to the Configure MCP can carry your preferences
across repos, machines, and agents. One doctrine, three ways to install it:

## Claude Code
Install the `configure-memory` skill (`node install.mjs` from the skill
folder, or the marketplace once published). First run registers a SessionStart
hook that injects a compact profile digest into every session — your agent
knows you before its first reply, and saves what it learns as it works.

## Codex / Cursor / Devin / anything with an AGENTS.md
Paste the [AGENTS block](./AGENTS-block.md) into your AGENTS.md or system
prompt. Same doctrine, no hooks required.

## Moving between agents
Nothing to migrate. Every agent reads and writes the same profile: what
Claude Code learns about you today, Codex knows tomorrow. To seed a new agent
instantly, say: "save everything you know about me to my Configure profile"
before you switch.

## llms.txt section (append to configure.dev/llms.txt)

# Configure for coding agents
Configure gives the current user a portable engineering memory. If you are a
coding agent with configure_* tools available: read the profile once at
session start; search it before preference-sensitive decisions; silently save
durable user preferences and cross-repo lessons to box "dev-preferences" via
configure_profile_remember as you learn them. The user considers this
paramount. Repo-specific facts stay in the repo's AGENTS.md/CLAUDE.md.
Skill + drop-in blocks: https://docs.configure.dev/coding-agents
````

- [ ] **Step 3: Commit**

```bash
git add skills/configure-memory/formats/
git commit -m "feat(skill): portable formats — AGENTS.md block + docs/llms.txt draft"
```

---

### Task 3: Credential discovery (TDD)

**Files:**
- Create: `skills/configure-memory/engine/credentials.mjs`
- Test: `test/skill/credentials.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { findConfigureCredentials } from "../../skills/configure-memory/engine/credentials.mjs";

const dump = JSON.stringify({
  mcpOAuth: {
    "supabase|59e49": { serverName: "supabase", serverUrl: "https://x", accessToken: "nope" },
    "configure|ab12": { serverName: "configure", serverUrl: "https://mcp.configure.dev", accessToken: "tok_123" },
  },
});

describe("findConfigureCredentials", () => {
  it("prefers CONFIGURE_TOKEN env override", () => {
    const c = findConfigureCredentials({ env: { CONFIGURE_TOKEN: "envtok" }, keychainDump: dump });
    expect(c).toEqual({ accessToken: "envtok", serverUrl: "https://mcp.configure.dev" });
  });
  it("finds the configure entry in a keychain dump", () => {
    const c = findConfigureCredentials({ env: {}, keychainDump: dump });
    expect(c?.accessToken).toBe("tok_123");
    expect(c?.serverUrl).toBe("https://mcp.configure.dev");
  });
  it("matches by serverUrl when serverName differs", () => {
    const d = JSON.stringify({ mcpOAuth: { "x|1": { serverName: "cfg", serverUrl: "https://mcp.configure.dev/mcp", accessToken: "t2" } } });
    expect(findConfigureCredentials({ env: {}, keychainDump: d })?.accessToken).toBe("t2");
  });
  it("returns null on no match / bad JSON / null dump", () => {
    expect(findConfigureCredentials({ env: {}, keychainDump: "{}" })).toBeNull();
    expect(findConfigureCredentials({ env: {}, keychainDump: "not json" })).toBeNull();
    expect(findConfigureCredentials({ env: {}, keychainDump: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/skill/credentials.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `engine/credentials.mjs`**

```js
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/skill/credentials.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add skills/configure-memory/engine/credentials.mjs test/skill/credentials.test.ts
git commit -m "feat(skill): credential discovery from Claude Code auth store"
```

---

### Task 4: Minimal MCP client (TDD)

**Files:**
- Create: `skills/configure-memory/engine/mcp-client.mjs`
- Test: `test/skill/mcp-client.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { callTool } from "../../skills/configure-memory/engine/mcp-client.mjs";

function jsonRes(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true, status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? (k.toLowerCase() === "content-type" ? "application/json" : null) },
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
      return jsonRes({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ linked: true }) }] } });
    });
    const out = await callTool({ serverUrl: "https://s", accessToken: "t", name: "configure_profile_read", fetchImpl });
    expect(out).toEqual({ linked: true });
    expect(calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    const lastHeaders = fetchImpl.mock.calls[2][1].headers;
    expect(lastHeaders["mcp-session-id"]).toBe("s1");
    expect(lastHeaders.authorization).toBe("Bearer t");
  });
  it("parses SSE responses (last data line wins)", async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"ok\\":1}"}]}}\n\n';
    const fetchImpl = vi.fn(async (_u: string, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.method === "initialize") return jsonRes({ jsonrpc: "2.0", id: 1, result: {} });
      if (body.method === "notifications/initialized") return jsonRes({});
      return {
        ok: true, status: 200,
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/skill/mcp-client.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `engine/mcp-client.mjs`**

```js
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
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "configure-memory-hook", version: "2.0.0" } },
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
  try { return JSON.parse(text); } catch { return text; }
}

async function parseRpc(res) {
  const ct = res.headers.get("content-type") || "";
  const body = await res.text();
  if (ct.includes("text/event-stream")) {
    const datas = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(datas[i]);
        if (j.result !== undefined || j.error !== undefined) return j;
      } catch {}
    }
    return {};
  }
  try { return JSON.parse(body); } catch { return {}; }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/skill/mcp-client.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add skills/configure-memory/engine/mcp-client.mjs test/skill/mcp-client.test.ts
git commit -m "feat(skill): minimal MCP streamable-HTTP client"
```

---

### Task 5: Digest composer (TDD)

**Files:**
- Create: `skills/configure-memory/engine/digest.mjs`
- Test: `test/skill/digest.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { composeDigest, CAP_CHARS } from "../../skills/configure-memory/engine/digest.mjs";

const profile = {
  identity: { name: "Manuel David", role: "software engineer", company: "Paradigm", email: "m@x.dev" },
  self: { id: "agents/mcp-abc", memory_count: 3 },
  boxes: [{ id: "dev-preferences", count: 4 }, { id: "work", count: 5 }],
  sources: [{ id: "agents/claude-code", count: 31 }, { id: "imports/chatgpt", count: 79 }],
  changesSince: { memories: [{ text: "newest fact", date: "2026-07-19" }, { text: "older" }] },
};
const devBox = { facts: [{ text: "Prefers pnpm everywhere" }, { text: "Strict TypeScript always" }] };

describe("composeDigest", () => {
  it("includes header, identity, self namespace, dev prefs, TOC, changes, doctrine", () => {
    const d = composeDigest(profile, devBox)!;
    expect(d).toContain("CONFIGURE DIGEST");
    expect(d).toContain("Manuel David");
    expect(d).toContain("agents/mcp-abc");
    expect(d).toContain("Prefers pnpm everywhere");
    expect(d).toContain("dev-preferences(4)");
    expect(d).toContain("agents/claude-code(31)");
    expect(d).toContain("2 newer");
    expect(d).toContain("dev-preferences");
    expect(d).toContain("configure_profile_search");
  });
  it("accepts alternate box shapes (memories / top_facts) and missing box", () => {
    expect(composeDigest(profile, { memories: [{ text: "alt" }] })).toContain("alt");
    expect(composeDigest(profile, null)).toContain("CONFIGURE DIGEST");
  });
  it("caps at CAP_CHARS", () => {
    const big = { ...profile, boxes: Array.from({ length: 400 }, (_, i) => ({ id: `box-${i}`, count: i })) };
    expect(composeDigest(big, devBox)!.length).toBeLessThanOrEqual(CAP_CHARS);
  });
  it("returns null without a profile", () => {
    expect(composeDigest(null, devBox)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/skill/digest.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `engine/digest.mjs`**

```js
export const CAP_CHARS = 3200; // ~800 tokens

// Index-not-content: identity + dev kernel + box TOC; bodies fetched on demand.
export function composeDigest(profile, devBox) {
  if (!profile) return null;
  const id = profile.identity || {};
  const lines = [];
  lines.push("CONFIGURE DIGEST — the user's portable memory. Deep lookups: configure_profile_search / configure_profile_read {box}.");
  const who = [id.name, id.role, id.company].filter(Boolean).join(", ");
  if (who) lines.push(`User: ${who}${id.email ? ` <${id.email}>` : ""}`);
  if (profile.self?.id)
    lines.push(`Own namespace: ${profile.self.id} (${profile.self.memory_count ?? 0} memories) — read your own writes there, not category boxes.`);
  const devFacts = (devBox?.facts || devBox?.memories || devBox?.top_facts || []).slice(0, 12);
  if (devFacts.length) {
    lines.push("Dev preferences:");
    for (const f of devFacts) lines.push(`- ${String(f.text ?? f).slice(0, 140)}`);
  }
  const toc = (arr) => (arr || []).map((b) => `${b.id}(${b.count})`).join(" ");
  const boxes = toc(profile.boxes);
  const sources = toc(profile.sources);
  if (boxes) lines.push(`Boxes: ${boxes}`);
  if (sources) lines.push(`Sources: ${sources}`);
  const changed = profile.changesSince?.memories?.length ?? 0;
  if (changed)
    lines.push(`Changes: ${changed} newer facts since last summary (freshest: ${String(profile.changesSince.memories[0]?.text ?? "").slice(0, 120)}).`);
  lines.push('Doctrine: as you learn durable user preferences or cross-repo lessons, silently configure_profile_remember them into box "dev-preferences". Search before saying anything about the user is not on file. Repo facts stay in CLAUDE.md.');
  let out = lines.join("\n");
  if (out.length > CAP_CHARS) out = out.slice(0, CAP_CHARS - 1) + "…";
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/skill/digest.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add skills/configure-memory/engine/digest.mjs test/skill/digest.test.ts
git commit -m "feat(skill): digest composer, 800-token cap, index-not-content"
```

---

### Task 6: SessionStart hook (TDD)

**Files:**
- Create: `skills/configure-memory/hooks/session-start.mjs`
- Test: `test/skill/session-start.test.ts`

Behavior policy: no credentials → print nothing, exit 0 (Configure not part of this project). Credentials but fetch fails → one-line nudge. Success → digest. Hard 2500ms overall guard inside the script; hook config timeout 5s.

- [ ] **Step 1: Write the failing tests** (test the exported `buildContext`, not the process wrapper)

```ts
import { describe, it, expect, vi } from "vitest";
import { buildContext } from "../../skills/configure-memory/hooks/session-start.mjs";

describe("buildContext", () => {
  it("returns null when no credentials found", async () => {
    expect(await buildContext({ findCreds: () => null, call: vi.fn() })).toBeNull();
  });
  it("returns digest on success (profile + dev box)", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ identity: { name: "M" }, self: { id: "agents/x", memory_count: 1 }, boxes: [], sources: [] })
      .mockResolvedValueOnce({ facts: [{ text: "pnpm" }] });
    const out = await buildContext({ findCreds: () => ({ accessToken: "t", serverUrl: "u" }), call });
    expect(out).toContain("CONFIGURE DIGEST");
    expect(out).toContain("pnpm");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("still returns digest when dev box read fails", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ identity: { name: "M" }, boxes: [], sources: [] })
      .mockRejectedValueOnce(new Error("boom"));
    const out = await buildContext({ findCreds: () => ({ accessToken: "t", serverUrl: "u" }), call });
    expect(out).toContain("CONFIGURE DIGEST");
  });
  it("returns the nudge when profile read fails", async () => {
    const call = vi.fn().mockRejectedValue(new Error("timeout"));
    const out = await buildContext({ findCreds: () => ({ accessToken: "t", serverUrl: "u" }), call });
    expect(out).toMatch(/configure_profile_read/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/skill/session-start.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `hooks/session-start.mjs`**

```js
#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { findConfigureCredentials } from "../engine/credentials.mjs";
import { callTool } from "../engine/mcp-client.mjs";
import { composeDigest } from "../engine/digest.mjs";

const NUDGE =
  "Configure is connected but the profile digest could not be fetched. Before your first substantive reply, call configure_profile_read once. As you learn durable user preferences, silently configure_profile_remember them into box \"dev-preferences\".";

export async function buildContext({ findCreds = findConfigureCredentials, call = callTool } = {}) {
  const creds = findCreds();
  if (!creds) return null; // Configure not set up here — stay silent.
  try {
    const profile = await call({ ...creds, name: "configure_profile_read", args: {}, timeoutMs: 2000 });
    let devBox = null;
    try {
      devBox = await call({ ...creds, name: "configure_profile_read", args: { box: "dev-preferences" }, timeoutMs: 1200 });
    } catch {}
    return composeDigest(profile, devBox) ?? NUDGE;
  } catch {
    return NUDGE;
  }
}

async function main() {
  const guard = new Promise((r) => setTimeout(() => r(NUDGE), 2500));
  let context = null;
  try {
    context = await Promise.race([buildContext(), guard]);
  } catch {}
  if (context)
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
```

Note the guard resolves to NUDGE (not null): the guard only matters when creds exist but the fetch hangs — creds-absent returns null instantly.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/skill/session-start.test.ts`
Expected: 4 passed

- [ ] **Step 5: Manual smoke of the wrapper**

Run: `node skills/configure-memory/hooks/session-start.mjs`
Expected: one line of JSON with `additionalContext` containing `CONFIGURE DIGEST` (this machine has live creds). Verify length of the context string is ≤ 3200 chars.

- [ ] **Step 6: Commit**

```bash
git add skills/configure-memory/hooks/session-start.mjs test/skill/session-start.test.ts
git commit -m "feat(skill): SessionStart hook — fail-soft digest injection"
```

---

### Task 7: Installer (TDD)

**Files:**
- Create: `skills/configure-memory/install.mjs`
- Test: `test/skill/install.test.ts`

Installs by COPY (not symlink) so the skill survives repo moves. Hook command uses the installed path. Idempotent; `--uninstall` removes hook entry (leaves skill dir). Backs up an existing `configure-memory` dir to `configure-memory.v1.bak` once.

- [ ] **Step 1: Write the failing tests**

```ts
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
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "other.sh" }] }] } }));
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/skill/install.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `install.mjs`**

```js
#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
export const HOOK_MATCHER = "startup|resume|compact";

export function install({ home = homedir() } = {}) {
  const skillsDir = join(home, ".claude", "skills");
  const dest = join(skillsDir, "configure-memory");
  mkdirSync(skillsDir, { recursive: true });
  if (existsSync(dest) && !isV2(dest)) {
    const bak = join(skillsDir, "configure-memory.v1.bak");
    if (!existsSync(bak)) renameSync(dest, bak);
  }
  cpSync(SRC, dest, { recursive: true, filter: (s) => !s.includes("node_modules") });

  const settingsPath = join(home, ".claude", "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const command = `node "${join(dest, "hooks", "session-start.mjs")}"`;
  const mine = settings.hooks.SessionStart.find((e) => e.matcher === HOOK_MATCHER && e.hooks?.some((h) => h.command?.includes("session-start.mjs")));
  if (!mine) settings.hooks.SessionStart.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command, timeout: 5 }] });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { dest, settingsPath };
}

export function uninstall({ home = homedir() } = {}) {
  const settingsPath = join(home, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (settings.hooks?.SessionStart)
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
      (e) => !(e.matcher === HOOK_MATCHER && e.hooks?.some((h) => h.command?.includes("session-start.mjs")))
    );
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function isV2(dir) {
  try { return readFileSync(join(dir, "SKILL.md"), "utf8").includes("always-write"); } catch { return false; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--uninstall")) { uninstall({}); console.log("configure-memory hooks removed"); }
  else { const { dest } = install({}); console.log(`configure-memory v2 installed at ${dest}; SessionStart hook registered`); }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/skill/install.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add skills/configure-memory/install.mjs test/skill/install.test.ts
git commit -m "feat(skill): idempotent installer — copy skill + register SessionStart hook"
```

---

### Task 8: Eval harness + RED baseline (v1 as-is)

**Files:**
- Create: `skills/configure-memory/evals/scenarios.json`
- Create: `skills/configure-memory/evals/run.mjs`

- [ ] **Step 1: Write `evals/scenarios.json`**

```json
{
  "shouldFire": [
    { "id": "scaffold", "prompt": "Set up a brand new TypeScript project for me in a temp folder. Pick the tooling." },
    { "id": "pkg-manager", "prompt": "Which package manager should I use for this new project?" },
    { "id": "test-framework", "prompt": "Add a test setup to this project. Choose the framework you think fits me." },
    { "id": "usual-deploy", "prompt": "How do I usually deploy my apps?" },
    { "id": "about-me", "prompt": "What do you know about me and how I like my code?" },
    { "id": "remember", "prompt": "Remember that I always want conventional commits with a scope." },
    { "id": "my-usual", "prompt": "Format this file my usual way." },
    { "id": "commit-style", "prompt": "Write a commit message for the staged changes, in my style." },
    { "id": "hit-before", "prompt": "Have I run into a Prisma connection pool issue before?" },
    { "id": "save-all", "prompt": "Save everything you learned about my preferences this session to my profile." }
  ],
  "shouldNotFire": [
    { "id": "explain-regex", "prompt": "What does this regex do: ^(?=.*[a-z])(?=.*[A-Z]).{8,}$" },
    { "id": "fix-type", "prompt": "This TypeScript error says 'Property x does not exist on type Y'. What does that mean generally?" },
    { "id": "explain-rebase", "prompt": "Explain the difference between git rebase and git merge." },
    { "id": "algo", "prompt": "Write a function that returns the nth Fibonacci number in Python." },
    { "id": "read-code", "prompt": "Read package.json and tell me what the build script does." },
    { "id": "mech-edit", "prompt": "In README.md change the word 'colour' to 'color' everywhere." }
  ]
}
```

- [ ] **Step 2: Write `evals/run.mjs`**

```js
#!/usr/bin/env node
// Usage: node evals/run.mjs [--label baseline] [--only shouldFire] [--max N]
// Runs each scenario headless in the CURRENT cwd (must be a project with the
// configure MCP configured) and counts mcp__configure__ tool calls.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(readFileSync(join(HERE, "scenarios.json"), "utf8"));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const label = arg("label", "run");
const only = arg("only", null);
const max = Number(arg("max", "99"));

function runOne(s) {
  let out = "";
  try {
    out = execFileSync(
      "claude",
      ["-p", s.prompt, "--output-format", "stream-json", "--verbose", "--max-turns", "6",
       "--allowedTools", "mcp__configure__*,Read,Bash,Write,Edit,Glob,Grep"],
      { encoding: "utf8", timeout: 300000 }
    );
  } catch (e) {
    out = String(e.stdout || "");
  }
  const calls = [];
  for (const line of out.split("\n")) {
    try {
      const j = JSON.parse(line);
      const blocks = j.message?.content ?? [];
      for (const b of blocks) if (b.type === "tool_use" && b.name?.startsWith("mcp__configure__")) calls.push(b.name);
    } catch {}
  }
  return calls;
}

const results = [];
for (const group of ["shouldFire", "shouldNotFire"]) {
  if (only && only !== group) continue;
  for (const s of scenarios[group].slice(0, max)) {
    const calls = runOne(s);
    const fired = calls.length > 0;
    const pass = group === "shouldFire" ? fired : !fired;
    results.push({ group, id: s.id, fired, pass, calls });
    console.log(`${pass ? "PASS" : "FAIL"}  [${group}] ${s.id}  calls=${calls.join(",") || "none"}`);
  }
}
const fire = results.filter((r) => r.group === "shouldFire");
const noFire = results.filter((r) => r.group === "shouldNotFire");
const pct = (arr) => (arr.length ? Math.round((100 * arr.filter((r) => r.pass).length) / arr.length) : NaN);
const summary = { label, date: new Date().toISOString(), shouldFirePassPct: pct(fire), shouldNotFirePassPct: pct(noFire), results };
mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", `${label}.json`), JSON.stringify(summary, null, 2));
console.log(`\nshould-fire: ${pct(fire)}%  should-not-fire clean: ${pct(noFire)}%  -> evals/results/${label}.json`);
```

- [ ] **Step 3: RED baseline (v1 still installed — do this BEFORE Task 9)**

Run from the repo root: `node skills/configure-memory/evals/run.mjs --label baseline-v1`
Expected: completes with a summary line; record the percentages. Read 2–3 FAIL transcripts' final text for verbatim rationalizations; add any new ones to SKILL.md's red-flag table (amend commit).

- [ ] **Step 4: Commit**

```bash
git add skills/configure-memory/evals/
git commit -m "feat(skill): in-agent eval harness + v1 baseline results"
```

---

### Task 9: Install v2, live smoke, GREEN eval

**Files:**
- Modify: `~/.claude/skills/configure-memory/` (via installer)

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run test/skill/`
Expected: all green

- [ ] **Step 2: Install**

Run: `node skills/configure-memory/install.mjs`
Expected: prints installed path + hook registered. Verify: `cat ~/.claude/settings.json | grep -A3 session-start` shows one entry; `ls ~/.claude/skills/configure-memory.v1.bak` exists.

- [ ] **Step 3: Live digest smoke**

Run: `claude -p "Say only: ready" --output-format json --max-turns 1` then check the hook fired: run `node ~/.claude/skills/configure-memory/hooks/session-start.mjs` directly and confirm JSON output contains `CONFIGURE DIGEST`, dev-preferences facts, and `Own namespace:`. Confirm `additionalContext.length <= 3200`.

- [ ] **Step 4: GREEN eval**

Run: `node skills/configure-memory/evals/run.mjs --label v2`
Expected: should-fire ≥ 90% (target 95), should-not-fire clean ≥ 95%. If below target: tune ONLY the SKILL.md description (add missed trigger phrases, sharpen negative constraint), re-run `node skills/configure-memory/install.mjs`, re-run the failing group with `--only`. Iterate max 3 rounds; record each round's numbers in `evals/results/`.

- [ ] **Step 5: Write-quality spot check**

In the `remember` and `save-all` scenario transcripts, verify: fact went to box `dev-preferences`, no permission-asking, no "saved to your profile" narration in the reply, and no repo-trivia saves in the `shouldNotFire` runs (pollution check).

- [ ] **Step 6: Commit results**

```bash
git add skills/configure-memory/evals/results/ skills/configure-memory/SKILL.md
git commit -m "test(skill): v2 eval results + description tuning"
```

---

### Task 10: README + wrap-up

**Files:**
- Create: `skills/configure-memory/README.md`

- [ ] **Step 1: Write README.md**

````markdown
# configure-memory v2

The always-write doctrine: any coding agent connected to the user's Configure
profile reads it at session start, prechecks it before preference-sensitive
decisions, and silently saves durable user preferences and cross-repo lessons
to the `dev-preferences` box as it works.

## Install (Claude Code)

```bash
node install.mjs          # copies skill to ~/.claude/skills + registers SessionStart hook
node install.mjs --uninstall
```

The hook injects a ≤800-token profile digest at session start (startup,
resume, and post-compaction). Read-only, fail-soft: no Configure credentials →
silent no-op; unreachable → one-line nudge; never blocks the session.

## Other agents

- `formats/AGENTS-block.md` — paste into AGENTS.md / system prompt.
- `formats/docs-page.md` — docs.configure.dev + llms.txt drafts.

## Evals

```bash
node evals/run.mjs --label <name>   # runs claude -p scenarios, counts configure tool calls
```

## Layout

- `SKILL.md` — the doctrine (Claude Code skill format)
- `engine/` — credential discovery, MCP client, digest composer (zero-dep)
- `hooks/session-start.mjs` — SessionStart entrypoint
- `install.mjs` — idempotent installer
````

- [ ] **Step 2: Full test run + commit**

```bash
npx vitest run test/skill/
git add skills/configure-memory/README.md
git commit -m "docs(skill): configure-memory v2 README"
```

- [ ] **Step 3: Board sync + report to Manuel (NO push without talking to him first — his standing protocol)**

Run: `node ~/.claude/skills/claude-classroom/classroom.js sync "configure-memory v2 built + evaled: <numbers>. Formats ready for docs/connect-flow wiring (memory-link side)."`
Then report eval numbers and open items (docs-site wiring, connect-flow nudge, MCP tweak decision) to Manuel.
