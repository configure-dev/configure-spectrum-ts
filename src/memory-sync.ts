import { randomUUID } from "node:crypto";
import { Configure } from "configure";
import type { ProfileRuntime } from "./types.js";

/**
 * Configure Memory Sync
 * ---------------------
 *
 * A framework-agnostic building block that lets a signed-in Configure user push
 * the memory a consumer assistant (ChatGPT, Claude, Gemini, Grok, ...) has saved
 * about them into their own Configure profile — without copy/paste.
 *
 * The mechanism does not depend on the assistant supporting custom tools. It
 * depends only on the one capability every mainstream assistant already has: the
 * ability to open a URL with its web/browsing tool. Configure issues the signed-in
 * user a short-lived, single-user sync endpoint; the assistant is instructed (via
 * `llms.txt`) to recall the user's saved memory and send it to that endpoint. The
 * endpoint validates the token and commits the memory into the bound Configure
 * profile.
 *
 * Two transports feed the same ingestion core:
 *   1. POST JSON to `/{token}/ingest` — used by assistants/connectors that can
 *      make an HTTP POST (the reliable path, e.g. a real MCP connector tool).
 *   2. Chunked `GET /{token}/chunk?seq=&data=` then `GET /{token}/commit` — used by
 *      a plain chat assistant that can only *open* URLs. The payload is sliced
 *      under a safe URL length, sent in order, and reassembled server-side.
 *
 * This is a first-party, user-consented data-portability flow. The token is bound
 * to the authenticated user, is short-lived, and only ever writes to that user's
 * own profile.
 */

export type MemorySyncSource = "chatgpt" | "claude" | "gemini" | "grok" | "generic" | (string & {});

/** Providers Configure recognizes as import sources (filed under `imports/<provider>`). */
export const MEMORY_SYNC_PROVIDERS = ["chatgpt", "claude", "gemini", "grok"] as const;

/** A stored, user-bound sync grant. */
export interface MemorySyncTokenRecord {
  /** Opaque sync token (the `{token}` in the sync URL). */
  token: string;
  /** Linked-profile agent token (`configure.profile({ token })`). */
  configureToken?: string;
  /** Developer-scoped external id (`configure.profile({ externalId })`) fallback. */
  externalId?: string;
  /** Which assistant the memory is coming from. */
  source: MemorySyncSource;
  /** Optional human label (e.g. the agent/display name). */
  label?: string;
  createdAt: string;
  expiresAt: string;
  /** Last time memory was committed with this token. */
  usedAt?: string;
  /** Running total of memories committed with this token. */
  committedMemoryCount?: number;
}

/** A buffered chunk in a chunked (URL-only) upload. */
export interface MemorySyncChunk {
  seq: number;
  data: string;
}

/**
 * Persistence for sync tokens and in-flight chunk buffers. Provide a durable
 * implementation (Redis, a table, ...) in production; {@link localMemorySyncStore}
 * is an in-process implementation for development and tests.
 */
export interface MemorySyncStore {
  saveSyncToken(record: MemorySyncTokenRecord): Promise<void>;
  getSyncToken(token: string): Promise<MemorySyncTokenRecord | null>;
  updateSyncToken(token: string, patch: Partial<MemorySyncTokenRecord>): Promise<void>;
  appendChunk(token: string, chunk: MemorySyncChunk): Promise<void>;
  readChunks(token: string): Promise<MemorySyncChunk[]>;
  clearChunks(token: string): Promise<void>;
}

export interface MemorySyncLimits {
  /** Maximum number of memories accepted in one commit. Default 1000. */
  maxMemories?: number;
  /** Maximum characters per memory (longer are truncated). Default 8000. */
  maxMemoryChars?: number;
  /** Maximum total characters accepted across all memories. Default 400000. */
  maxTotalChars?: number;
  /** Maximum buffered chunks per token. Default 2000. */
  maxChunks?: number;
  /** Recommended encoded slice length advertised in `llms.txt`. Default 1500. */
  chunkCharHint?: number;
}

export interface MemorySyncOptions {
  /** Configure secret key (`sk_...`). Required unless `configure` is provided. */
  apiKey?: string;
  /** Agent handle. Required unless `configure` is provided. */
  agent?: string;
  /** Publishable key (`pk_...`), used to build hosted sign-in URLs. */
  publishableKey?: string;
  /** Supply a pre-built Configure client instead of `apiKey`/`agent`. */
  configure?: Configure;
  store: MemorySyncStore;

  baseUrl?: string;
  timeout?: number;
  fetch?: typeof fetch;

  /** Hosted origin for the issued links. Default `https://sign-in.me`. */
  origin?: string;
  /** Mount path for the sync routes. Default `/sync`. */
  basePath?: string;
  /** Token lifetime in milliseconds. Default 30 minutes. */
  tokenTtlMs?: number;

  limits?: MemorySyncLimits;

  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable token generator (tests). */
  randomToken?: () => string;
}

export interface MemorySyncIssueInput {
  configureToken?: string;
  externalId?: string;
  source?: MemorySyncSource;
  label?: string;
}

export interface MemorySyncTicket {
  token: string;
  source: MemorySyncSource;
  /** The link the user pastes/opens: `https://sign-in.me/sync/{token}`. */
  syncUrl: string;
  /** Per-token instructions: `.../sync/{token}/llms.txt`. */
  instructionsUrl: string;
  /** POST ingest endpoint: `.../sync/{token}/ingest`. */
  ingestUrl: string;
  /** Chunk endpoint (URL-only transport): `.../sync/{token}/chunk`. */
  chunkUrl: string;
  /** Commit endpoint (URL-only transport): `.../sync/{token}/commit`. */
  commitUrl: string;
  /** Path-append template: `.../sync/{token}/m/<url-encoded memories>`. */
  saveUrlTemplate: string;
  /**
   * Provider-specific save prefixes so the source is known and filed into that
   * provider's box, e.g. `{ chatgpt: ".../sync/{token}/from/chatgpt/m/" }`.
   */
  providerSaveUrls: Record<MemorySyncSource, string>;
  expiresAt: string;
  /** Ready-to-paste kickoff prompt for the user. */
  prompt: string;
}

export interface MemorySyncSignInUrlInput {
  /** Where the hosted sign-in returns after quick auth (receives a `code`). */
  returnTo: string;
  /** Publishable key (`pk_...`). Falls back to the option set on the client. */
  publishableKey?: string;
  /** Opaque value echoed back with the sign-in code. */
  state?: string;
  source?: MemorySyncSource;
}

export interface MemorySyncCompleteSignInInput {
  /** Short-lived hosted sign-in `code` (preferred) — exchanged for a token. */
  code?: string;
  /** An already-minted Configure agent token to validate instead of a code. */
  token?: string;
  source?: MemorySyncSource;
  label?: string;
}

export interface MemorySyncCommitInput {
  token: string;
  /** Raw payload: string, string[], `{ memories }`, or `{ text }`. */
  payload: unknown;
  source?: MemorySyncSource;
}

export interface MemorySyncCommitResult {
  ok: boolean;
  status: number;
  committed: number;
  received: number;
  source: MemorySyncSource;
  reason?: string;
}

export interface MemorySyncHttpRequest {
  method: string;
  /** Path relative to `basePath` (leading slash), e.g. `/{token}/chunk`. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface MemorySyncHttpResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface MemorySync {
  /** Issue a user-bound sync grant + links after the user has authenticated. */
  issue(input: MemorySyncIssueInput): Promise<MemorySyncTicket>;
  /** Build the hosted quick-auth URL that starts a sync sign-in (the SSO entry). */
  signInUrl(input: MemorySyncSignInUrlInput): string;
  /**
   * Finish the SSO handoff: exchange the returned `code` (or validate a `token`)
   * for the user's Configure identity and mint a bound sync ticket. This is the
   * "quick auth -> unique URL issued to the user" step.
   */
  completeSignIn(input: MemorySyncCompleteSignInInput): Promise<MemorySyncTicket>;
  /** Render the `llms.txt` instruction body (generic, or personalized for a token). */
  instructions(input?: string | { token?: string; source?: MemorySyncSource }): string;
  /** Low-level: validate a token, parse the payload, and commit to Configure. */
  commit(input: MemorySyncCommitInput): Promise<MemorySyncCommitResult>;
  /** Normalized HTTP router covering every sync route. */
  handle(request: MemorySyncHttpRequest): Promise<MemorySyncHttpResponse>;
  /** WHATWG `fetch`-style adapter over {@link handle}. */
  fetchHandler(request: Request): Promise<Response>;
}

const DEFAULT_ORIGIN = "https://sign-in.me";
const DEFAULT_BASE_PATH = "/sync";
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LIMITS: Required<MemorySyncLimits> = {
  maxMemories: 1000,
  maxMemoryChars: 8000,
  maxTotalChars: 400_000,
  maxChunks: 2000,
  chunkCharHint: 1500,
};

export function createMemorySync(options: MemorySyncOptions): MemorySync {
  if (!options.store) throw new Error("createMemorySync: missing required option \"store\"");
  const configure = options.configure ?? buildConfigure(options);
  const store = options.store;
  const origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  const ttlMs = options.tokenTtlMs ?? DEFAULT_TTL_MS;
  const limits: Required<MemorySyncLimits> = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const now = options.now ?? (() => new Date());
  const mintToken = options.randomToken ?? (() => `mst_${randomUUID().replace(/-/g, "")}`);

  function links(token: string) {
    const syncUrl = `${origin}${basePath}/${token}`;
    const providerSaveUrls: Record<string, string> = {};
    for (const provider of MEMORY_SYNC_PROVIDERS) {
      providerSaveUrls[provider] = `${syncUrl}/from/${provider}/m/`;
    }
    return {
      syncUrl,
      instructionsUrl: `${syncUrl}/llms.txt`,
      ingestUrl: `${syncUrl}/ingest`,
      chunkUrl: `${syncUrl}/chunk`,
      commitUrl: `${syncUrl}/commit`,
      saveUrlTemplate: `${syncUrl}/m/<url-encoded-memories>`,
      providerSaveUrls,
    };
  }

  async function issue(input: MemorySyncIssueInput): Promise<MemorySyncTicket> {
    if (!input.configureToken && !input.externalId) {
      throw new Error("memorySync.issue requires a configureToken (linked user) or externalId");
    }
    const source = input.source ?? "generic";
    const token = mintToken();
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    const record: MemorySyncTokenRecord = {
      token,
      ...(input.configureToken ? { configureToken: input.configureToken } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
      source,
      ...(input.label ? { label: input.label } : {}),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    await store.saveSyncToken(record);
    const l = links(token);
    return {
      token,
      source,
      ...l,
      expiresAt: record.expiresAt,
      prompt: kickoffPrompt(l.instructionsUrl, l.syncUrl),
    };
  }

  function signInUrl(input: MemorySyncSignInUrlInput): string {
    const publishableKey = input.publishableKey ?? options.publishableKey;
    if (!publishableKey) {
      throw new Error("memorySync.signInUrl requires a publishableKey (option or argument)");
    }
    return configure.auth.signInUrl({
      publishableKey,
      returnTo: input.returnTo,
      delivery: "browser",
      signInOrigin: origin,
      ...(input.state ? { state: input.state } : {}),
    });
  }

  async function completeSignIn(input: MemorySyncCompleteSignInInput): Promise<MemorySyncTicket> {
    let configureToken: string;
    if (input.code) {
      const exchange = await configure.auth.exchangeSignInCode(input.code);
      if (exchange.approved === false || !exchange.token) {
        throw new Error("memorySync.completeSignIn: sign-in was not approved");
      }
      configureToken = exchange.token;
    } else if (input.token) {
      const validation = await configure.auth.validateSignInToken(input.token);
      if (!validation.valid || validation.approved === false) {
        throw new Error("memorySync.completeSignIn: sign-in token is invalid or unapproved");
      }
      configureToken = input.token;
    } else {
      throw new Error("memorySync.completeSignIn requires a code or token");
    }
    return issue({ configureToken, source: input.source, label: input.label });
  }

  function instructions(input?: string | { token?: string; source?: MemorySyncSource }): string {
    const token = typeof input === "string" ? input : input?.token;
    const source = typeof input === "string" ? undefined : input?.source;
    return renderInstructions({ token, source, origin, basePath, limits });
  }

  async function commit(input: MemorySyncCommitInput): Promise<MemorySyncCommitResult> {
    const record = await store.getSyncToken(input.token);
    if (!record) {
      return { ok: false, status: 404, committed: 0, received: 0, source: input.source ?? "generic", reason: "unknown_token" };
    }
    const source = input.source ?? record.source ?? "generic";
    if (Date.parse(record.expiresAt) <= now().getTime()) {
      return { ok: false, status: 410, committed: 0, received: 0, source, reason: "expired" };
    }
    if (!record.configureToken && !record.externalId) {
      return { ok: false, status: 409, committed: 0, received: 0, source, reason: "token_not_bound" };
    }

    const { committed, received } = await commitMemories(
      configure,
      { configureToken: record.configureToken, externalId: record.externalId },
      input.payload,
      limits
    );
    if (committed === 0) {
      return { ok: false, status: 422, committed: 0, received, source, reason: "no_memories" };
    }

    await store.updateSyncToken(record.token, {
      usedAt: now().toISOString(),
      committedMemoryCount: (record.committedMemoryCount ?? 0) + committed,
    });

    return { ok: true, status: 200, committed, received, source };
  }

  async function bufferChunk(token: string, seq: number, data: string): Promise<MemorySyncHttpResponse> {
    const record = await store.getSyncToken(token);
    if (!record) return json(404, { ok: false, error: "unknown_token" });
    if (Date.parse(record.expiresAt) <= now().getTime()) return json(410, { ok: false, error: "expired" });
    if (!Number.isInteger(seq) || seq < 0 || seq >= limits.maxChunks) {
      return json(422, { ok: false, error: "bad_seq" });
    }
    const existing = await store.readChunks(token);
    if (existing.length >= limits.maxChunks) return json(413, { ok: false, error: "too_many_chunks" });
    await store.appendChunk(token, { seq, data: data ?? "" });
    return json(200, { ok: true, seq, buffered: existing.length + 1 });
  }

  async function commitBufferedChunks(token: string, source?: MemorySyncSource): Promise<MemorySyncHttpResponse> {
    const chunks = await store.readChunks(token);
    if (chunks.length === 0) {
      return json(422, { ok: false, error: "no_chunks" });
    }
    const reassembled = reassembleChunks(chunks);
    const result = await commit({ token, payload: reassembled, source });
    if (result.ok) await store.clearChunks(token);
    return json(result.status, result.ok
      ? { ok: true, committed: result.committed, received: result.received, source: result.source }
      : { ok: false, error: result.reason, received: result.received });
  }

  async function status(token: string): Promise<MemorySyncHttpResponse> {
    const record = await store.getSyncToken(token);
    if (!record) return json(404, { ok: false, error: "unknown_token" });
    const expired = Date.parse(record.expiresAt) <= now().getTime();
    const buffered = (await store.readChunks(token)).length;
    return json(200, {
      ok: true,
      source: record.source,
      expired,
      expiresAt: record.expiresAt,
      committedMemoryCount: record.committedMemoryCount ?? 0,
      bufferedChunks: buffered,
    });
  }

  async function handle(request: MemorySyncHttpRequest): Promise<MemorySyncHttpResponse> {
    const method = request.method.toUpperCase();
    const segments = request.path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    const query = request.query ?? {};

    // GET /llms.txt  (generic, no token)
    if (segments.length === 1 && segments[0] === "llms.txt") {
      if (method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });
      return text(200, instructions({ source: sourceOf(query) }));
    }

    const token = segments[0];
    if (!token) return json(404, { ok: false, error: "not_found" });

    // Optional provider prefix: /{token}/from/{provider}/... tells us which
    // assistant the memory came from (chatgpt, claude, ...) so it can be filed
    // into that provider's box. Splice it out so the rest of the router is
    // provider-agnostic, and use it as the source when committing.
    let routeSegments = segments;
    let routeProvider: MemorySyncSource | undefined;
    if (segments[1] === "from" && segments[2]) {
      routeProvider = segments[2];
      routeSegments = [token, ...segments.slice(3)];
    }
    const action = routeSegments[1];
    const source = routeProvider ?? sourceOf(query, request.body);

    // GET /{token}/llms.txt (or /{token}/from/{provider}/llms.txt)
    if (action === "llms.txt") {
      if (method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });
      return text(200, instructions({ token, source: source ?? sourceOf(query) }));
    }

    // GET /{token}  or  /{token}/status
    if (action === undefined || action === "status") {
      if (method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });
      return status(token);
    }

    // POST /{token}/ingest   (body payload -> commit)
    // GET  /{token}/ingest?data=... (single-shot small payload -> commit)
    if (action === "ingest") {
      if (method === "POST") {
        const result = await commit({ token, payload: request.body, source });
        return json(result.status, result.ok
          ? { ok: true, committed: result.committed, received: result.received, source: result.source }
          : { ok: false, error: result.reason, received: result.received });
      }
      if (method === "GET") {
        const data = query.data ?? query.d;
        if (data === undefined) return json(422, { ok: false, error: "missing_data" });
        const result = await commit({ token, payload: data, source });
        return json(result.status, result.ok
          ? { ok: true, committed: result.committed, received: result.received, source: result.source }
          : { ok: false, error: result.reason, received: result.received });
      }
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    // GET /{token}/m/<...memories>  — memories appended directly in the URL path.
    // With a provider prefix: GET /{token}/from/{provider}/m/<...memories>.
    // This is the primary plain-chat path: the assistant opens one URL with the
    // (url-encoded, newline- or slash-separated) memory appended after `/m/`.
    if (action === "m" || action === "save") {
      if (method !== "GET" && method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
      const rest = routeSegments.slice(2);
      const inlineData = query.data ?? query.d;
      const payload = rest.length > 0
        ? rest.map(decodePathSegment).join("\n")
        : inlineData;
      if (payload === undefined) return json(422, { ok: false, error: "missing_data" });
      const result = await commit({ token, payload, source });
      return json(result.status, result.ok
        ? { ok: true, committed: result.committed, received: result.received, source: result.source }
        : { ok: false, error: result.reason, received: result.received });
    }

    // GET  /{token}/chunk?seq=&data=
    // POST /{token}/chunk  { seq, data }
    if (action === "chunk") {
      if (method === "GET") {
        const seq = Number.parseInt(query.seq ?? query.i ?? "", 10);
        const data = query.data ?? query.d ?? "";
        return bufferChunk(token, seq, data);
      }
      if (method === "POST") {
        const b = asObject(request.body);
        const seq = typeof b.seq === "number" ? b.seq : Number.parseInt(String(b.seq ?? ""), 10);
        const data = typeof b.data === "string" ? b.data : "";
        return bufferChunk(token, seq, data);
      }
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    // GET|POST /{token}/commit  (reassemble buffered chunks -> commit)
    if (action === "commit") {
      if (method !== "GET" && method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
      return commitBufferedChunks(token, source);
    }

    return json(404, { ok: false, error: "not_found" });
  }

  async function fetchHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;
    if (basePath !== "/" && path.startsWith(basePath)) path = path.slice(basePath.length) || "/";
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    let body: unknown;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const raw = await request.text();
      body = raw ? safeJsonOrText(raw) : undefined;
    }
    const response = await handle({ method: request.method, path, query, body });
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.contentType },
    });
  }

  return { issue, signInUrl, completeSignIn, instructions, commit, handle, fetchHandler };
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The Configure profile a commit writes to. */
export interface MemorySyncIdentity {
  /** Linked-profile agent token (`configure.profile({ token })`). */
  configureToken?: string;
  /** Developer-scoped external id (`configure.profile({ externalId })`). */
  externalId?: string;
}

/**
 * Parse a payload into memories and commit them to a Configure profile. Shared by
 * the HTTP ingest routes and the MCP connector tools. Returns `{ committed: 0 }`
 * without calling Configure when the payload yields no memories.
 */
export async function commitMemories(
  configure: Configure,
  identity: MemorySyncIdentity,
  payload: unknown,
  limits?: MemorySyncLimits
): Promise<{ committed: number; received: number }> {
  if (!identity.configureToken && !identity.externalId) {
    throw new Error("commitMemories requires a configureToken or externalId");
  }
  const parsed = parseMemories(payload, limits);
  if (parsed.memories.length === 0) return { committed: 0, received: parsed.received };
  const runtime: ProfileRuntime = configure.profile(
    identity.configureToken ? { token: identity.configureToken } : { externalId: identity.externalId }
  );
  await runtime.commit({ memories: parsed.memories, sync: true });
  return { committed: parsed.memories.length, received: parsed.received };
}

// --- pure helpers (exported for testing) -----------------------------------

/** Reassemble ordered chunks into the original newline-joined memory text. */
export function reassembleChunks(chunks: MemorySyncChunk[]): string {
  return [...chunks]
    .sort((a, b) => a.seq - b.seq)
    .map((chunk) => chunk.data)
    .join("");
}

export interface ParsedMemories {
  memories: string[];
  received: number;
}

/** Normalize an arbitrary payload into a capped, de-duplicated memory list. */
export function parseMemories(payload: unknown, limits: MemorySyncLimits = {}): ParsedMemories {
  const merged: Required<MemorySyncLimits> = { ...DEFAULT_LIMITS, ...limits };
  const rawItems = extractRawItems(payload);
  const received = rawItems.length;

  const out: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  for (const rawItem of rawItems) {
    let memory = normalizeMemoryLine(rawItem);
    if (!memory) continue;
    if (memory.length > merged.maxMemoryChars) memory = memory.slice(0, merged.maxMemoryChars);
    const key = memory.toLowerCase();
    if (seen.has(key)) continue;
    if (totalChars + memory.length > merged.maxTotalChars) break;
    if (out.length >= merged.maxMemories) break;
    seen.add(key);
    totalChars += memory.length;
    out.push(memory);
  }
  return { memories: out, received };
}

function extractRawItems(payload: unknown): string[] {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload.map((item) => String(item ?? ""));
  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.memories)) return obj.memories.map((item) => String(item ?? ""));
    if (typeof obj.text === "string") return splitLines(obj.text);
    if (typeof obj.data === "string") return extractRawItems(safeJsonOrText(obj.data));
    return [];
  }
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return extractRawItems(JSON.parse(trimmed));
      } catch {
        /* fall through to line splitting */
      }
    }
    return splitLines(payload);
  }
  return [String(payload)];
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function normalizeMemoryLine(line: string): string | null {
  let value = String(line ?? "").trim();
  if (!value) return null;
  // strip common list markers a model may prepend
  value = value.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
  if (value.length < 2) return null;
  return value;
}

function sourceOf(query: Record<string, string | undefined>, body?: unknown): MemorySyncSource | undefined {
  const fromQuery = query.source ?? query.s;
  if (fromQuery) return fromQuery;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const value = (body as Record<string, unknown>).source;
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function safeJsonOrText(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* not JSON */
    }
  }
  return raw;
}

function buildConfigure(options: MemorySyncOptions): Configure {
  if (!options.apiKey) throw new Error("createMemorySync: missing required option \"apiKey\" (or pass a Configure client)");
  if (!options.agent) throw new Error("createMemorySync: missing required option \"agent\" (or pass a Configure client)");
  return new Configure({
    apiKey: options.apiKey,
    agent: options.agent,
    baseUrl: options.baseUrl,
    timeout: options.timeout,
    fetch: options.fetch,
  });
}

function normalizeBasePath(basePath: string): string {
  if (!basePath || basePath === "/") return "/";
  return `/${basePath.replace(/^\/+|\/+$/g, "")}`;
}

function json(status: number, body: unknown): MemorySyncHttpResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) };
}

function text(status: number, body: string): MemorySyncHttpResponse {
  return { status, contentType: "text/plain; charset=utf-8", body };
}

function kickoffPrompt(instructionsUrl: string, syncUrl: string): string {
  return [
    `Export everything you remember about me to my Configure profile.`,
    `First open ${instructionsUrl} and follow it exactly.`,
    `My personal sync link is ${syncUrl}.`,
  ].join(" ");
}

function renderInstructions(input: {
  token?: string;
  source?: MemorySyncSource;
  origin: string;
  basePath: string;
  limits: Required<MemorySyncLimits>;
}): string {
  const { token, origin, basePath, limits } = input;
  const source = input.source ?? "chatgpt";
  const hasToken = Boolean(token);
  const tokenSlug = hasToken ? token! : "<your-token>";
  const syncUrl = `${origin}${basePath}/${tokenSlug}`;
  // When we explicitly know the provider, route through /from/<provider>/ so the
  // memory is filed into that provider's box (imports/<provider>).
  const isProvider = input.source !== undefined && (MEMORY_SYNC_PROVIDERS as readonly string[]).includes(input.source);
  const base = isProvider ? `${syncUrl}/from/${input.source}` : syncUrl;
  const saveUrl = `${base}/m`;
  const chunkUrl = `${base}/chunk`;
  const commitUrl = `${base}/commit`;
  const ingestUrl = `${base}/ingest`;

  const tokenNote = hasToken
    ? `This is your unique, expiring sync link. It is bound to one Configure account
and only writes to that user's own profile.`
    : `You do not have a personal sync link yet. Ask the user to open ${origin}${basePath},
sign in (quick auth), and paste back their personal link — it looks like
${origin}${basePath}/<your-token>. Then follow the steps below with that link.`;

  return `# Configure Memory Sync — instructions for the assistant

You are helping the user export THEIR OWN saved memory from this assistant into
their personal Configure profile (https://configure.dev). The user started this
themselves and signed in to get the link below. This is a consented, first-party
data-portability action on the user's own data — like exporting your own data.

Rules:
- Only export what THIS assistant has saved about THIS user.
- Send memory verbatim. Do not invent or embellish.
- Never include secrets: passwords, API keys, one-time codes, full card or bank
  numbers. Skip those.
- If the user did not ask for this, stop and ask them first.

## Step 1 — gather the memory
Recall everything this assistant has stored about the user:
- saved memories / "what you know about me" / personalization
- stated preferences and communication style
- ongoing projects, goals, and durable personal facts
Write one memory per line, plain text, no numbering, no commentary.

## ${tokenNote}

## Step 2 — send it by opening a URL (works with your normal web tool)

### If the whole memory fits in one URL (under ~${limits.chunkCharHint} characters encoded)
URL-encode the memory text and open this URL once:

  ${saveUrl}/<URL-ENCODED-MEMORY-TEXT>

Example: for "likes tea" and "based in NYC", open

  ${saveUrl}/likes%20tea%0Abased%20in%20NYC

Everything after \`/m/\` is your data; encode newlines as %0A. This single call saves
the memory immediately.

### If the memory is long (more than one URL's worth)
Split the URL-encoded text into slices under ~${limits.chunkCharHint} characters.
Open each slice IN ORDER (this buffers, it does not save yet):

  ${chunkUrl}?seq=0&data=<first-slice>
  ${chunkUrl}?seq=1&data=<second-slice>
  ...

Then open COMMIT exactly once to save the reassembled memory:

  ${commitUrl}

Do not add or drop any characters when slicing.

## Step 3 — confirm
The saving call returns JSON like {"ok":true,"committed":42}. Report that count to
the user. If a call returns 404/410 or {"error":"expired"}, the link has expired —
tell the user to get a fresh one from Configure.

## Alternate transport (connectors/tools only)
If you can make an HTTP POST, POST {"source":"${source}","memories":[...]} to
${ingestUrl}.

You can run the sync again later with a fresh link; new memories are merged.
`;
}

/** In-process {@link MemorySyncStore} for development and tests. */
export function localMemorySyncStore(): MemorySyncStore {
  const tokens = new Map<string, MemorySyncTokenRecord>();
  const chunks = new Map<string, MemorySyncChunk[]>();
  return {
    async saveSyncToken(record) {
      tokens.set(record.token, { ...record });
    },
    async getSyncToken(token) {
      const record = tokens.get(token);
      return record ? { ...record } : null;
    },
    async updateSyncToken(token, patch) {
      const existing = tokens.get(token);
      if (!existing) return;
      tokens.set(token, { ...existing, ...patch });
    },
    async appendChunk(token, chunk) {
      const list = chunks.get(token) ?? [];
      // last write wins per seq, so a re-opened URL is idempotent
      const next = list.filter((item) => item.seq !== chunk.seq);
      next.push({ ...chunk });
      chunks.set(token, next);
    },
    async readChunks(token) {
      return (chunks.get(token) ?? []).map((chunk) => ({ ...chunk }));
    },
    async clearChunks(token) {
      chunks.delete(token);
    },
  };
}
