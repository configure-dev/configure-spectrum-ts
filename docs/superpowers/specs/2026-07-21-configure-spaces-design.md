# Configure Spaces — Cross-Account Shared Context (Design Spec)

**Date:** 2026-07-21
**Author:** Manuel + Claude (brainstormed)
**Status:** Design approved on the three pivotal decisions; four refinements defaulted (flagged inline for review).
**Builds on:** the `projects/<slug>` handoff pattern, the connect-link minting infra (PR #157), and the CFS/files storage layer.
**Implements:** the "Configure Orgs" roadmap item (Jul 20), in its lighter link-shared form.

---

## 1. The problem

Today a Configure profile is single-account: your agents read and write *your* memory. There is no way to share a slice of your context with a co-worker so that *their* agents can collaborate on it.

Manuel's ask, verbatim intent:

> Cross-org use with Configure so people can send links to co-workers and share a project in Configure space, and share context about that specific thing. Give someone limited access to your account with the MCP: a project separate from normal that my agents can see, but also anyone I send the link to (who signs in to Configure) can access with their agent. An easy way to co-work on a project with your agents having shared context. If I want to send the conversations I have had with Parry to the GTM engineer, I give him access to that namespace with a link and he can get it.

So: **a shared, link-invited, scoped context namespace that multiple people's agents can read and write, without exposing the owner's personal profile.**

## 2. Architectural template: `mddb`

`mddb` (the team's shared markdown-document DB at `mddb.dcoreai.com`) is the right shape to copy. It is a slug-namespaced document store that a whole team plus their agents read and write:

- **Slug-addressed documents** (`paradigm/development/architecture`, `betterbot/roadmap`) — hierarchical paths.
- **Per-entry attribution** — `by manuel / claude-code`, `by ashtin / manus-agent` (a user + agent chain).
- **Full-text search** (SQLite FTS5: stemmed + prefix).
- **Bounded line-window reads** so giant docs do not flood an agent's context.
- **Section upsert, append, history** for safe concurrent edits.
- **Multi-user, multi-agent** by design.

A Configure Space is a `mddb` scoped to one shared namespace with membership gating and Configure's identity/attribution model. It rides Configure's **files/CFS layer** (documents at paths), not the short-memory box layer — because the payload is documents and transcripts, not one-line judged facts, and Manuel framed it as "like making files."

## 3. Decisions (approved)

| Decision | Chosen |
|---|---|
| Access model | **Owner-owned; a link grants scoped access.** The space is yours. A link gives an invitee's account and agents access to *only* that namespace, never the rest of your profile. |
| Invitee rights | **Per-link role: `viewer` or `contributor`.** The owner picks when minting the link. Viewer reads; contributor reads and writes (attributed). |
| Primitive | **New `spaces/<slug>`.** Distinct from `projects/<slug>` (which stays your own single-account handoff). Clearer mental model and a hard security boundary. |

### Refinements (defaulted — review these)
1. **Leave-space:** members can leave a space themselves (`configure_space_leave`). *Default: include.*
2. **Discovery shelf:** a member's `configure_profile_read` surfaces a `spaces` shelf ("you are in `spaces/parry-gtm`") so their agent knows the shared context exists. *Default: include* — without it the agent never looks.
3. **Concurrent writes:** bring `mddb`-style section upsert plus lightweight per-doc version history, rather than blind last-write-wins. *Default: include upsert + history.*
4. **Seed bridge:** a one-shot "seed this space from these memories/docs of mine" so the owner can drop existing context (e.g. Parry transcripts) in fast. *Default: include as `configure_space_write` accepting a source-memory reference.*

## 4. What a Space is

An **owner-owned namespace** `spaces/<slug>` (for example `spaces/parry-gtm`) holding markdown documents at `spaces/<slug>/<doc-path>`. Each document is attributed to the `(user, agent)` that wrote it. Members access it through their own Configure identity; the owner controls membership and roles.

```
you (owner)
 └─ spaces/parry-gtm                      ← the shared space
      ├─ parry-context.md   written_by: manuel / parry
      ├─ gtm-notes.md        written_by: gtm-eng / their-agent
      └─ decisions.md        written_by: manuel / claude-code
    members:
      manuel        owner       (read + write + share + manage)
      gtm-eng       contributor (read + write, attributed)
    isolation: gtm-eng and their agents can reach ONLY this space,
               never manuel's personal profile, boxes, or other spaces.
```

## 5. Data model

Three small tables plus documents in CFS. Reuse existing storage; do not invent a new store.

```sql
-- A shared space, owned by one user.
CREATE TABLE spaces (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL,               -- unique per owner
  owner_user_id uuid NOT NULL REFERENCES users(id),
  title        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, slug)
);

-- Membership grants scoped access. The owner has an implicit 'owner' row.
CREATE TABLE space_members (
  space_id       uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  member_user_id uuid NOT NULL REFERENCES users(id),
  role           text NOT NULL CHECK (role IN ('owner','contributor','viewer')),
  granted_by     uuid NOT NULL REFERENCES users(id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, member_user_id)
);

-- Pending invites. Mirrors mcp_connect_sessions: hashed token, TTL, one role.
CREATE TABLE space_invites (
  id           text PRIMARY KEY,            -- 'spi_...'
  space_id     uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('contributor','viewer')),
  token_hash   text NOT NULL,
  created_by   uuid NOT NULL REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_by  uuid REFERENCES users(id),   -- null until first accept
  UNIQUE (space_id, role)                    -- reuse the same link for a role
);
```

**Documents** live in CFS under the space namespace, each node carrying `written_by: { user_id, agent }` and a `version` counter. Storage reuses `cfsService` + `cfsPermissions`; do not add a parallel doc store.

## 6. mddb to Configure mapping (the "architected like mddb" contract)

| mddb capability | Configure Space equivalent |
|---|---|
| `mddb_list` | `configure_space_read` with no doc path — returns the space table of contents |
| `mddb_get` / `mddb_read_lines` | `configure_space_read({ slug, doc, start_line?, end_line? })` — bounded window |
| `mddb_search` (FTS5) | `configure_space_search({ slug, query })` |
| `mddb_set` / `mddb_append` | `configure_space_write({ slug, doc, content, mode })` |
| `mddb_upsert_section` | `configure_space_write({ slug, doc, section, content })` |
| `mddb_history` | version counter per doc; `configure_space_read({ ..., history: true })` |
| slug `paradigm/development/...` | `spaces/<slug>/<doc-path>` |
| `by manuel / claude-code` | `written_by: { user, agent }` stamped on every write |

## 7. MCP tools (native, mirroring the file and connect tools)

All are backend-MCP native tools, contributed to `NATIVE_MCP_TOOLS`, gated by membership and role.

| Tool | Who | Does |
|---|---|---|
| `configure_space_list` | any member | List spaces I belong to, with my role. |
| `configure_space_read` | member | Read the space TOC, or a doc (bounded line window), or history. |
| `configure_space_search` | member | FTS5 over the space's docs. |
| `configure_space_write` | contributor, owner | Create/append/upsert a doc; stamps `written_by`; bumps version. |
| `configure_space_share` | owner | Mint an invite link with `role` and optional TTL. Returns `space_invite_url`. |
| `configure_space_members` | owner | List members; revoke a member. |
| `configure_space_leave` | member (not owner) | Remove myself from the space. |

`configure_space_create` is owner-only and can be implicit on first `configure_space_write` to a new slug (like create-on-write for boxes).

## 8. REST + SDK parity (the single-source rule)

Follow the exact pattern the forget/import/connect tools established (PR #145/#152/#157): the MCP tool logic is a single exported handler; REST routes are thin delegations; the SDK method calls the REST route. One implementation, three surfaces, no drift.

- **REST:** `POST /v1/spaces/:slug/read|search|write`, `POST /v1/spaces/:slug/share`, `GET /v1/spaces`, `POST /v1/spaces/:slug/members`, `POST /v1/spaces/:slug/leave`.
- **SDK:** `configure.spaces.list()`, `configure.space(slug).read()/search()/write()/share({role})/members()/leave()`.
- **Contract:** the `configure_space_*` tools join the shared `tool-contract` package so SDK and MCP schemas stay identical.

## 9. Sharing and join flow (reuses the connect-link infra)

The invite link reuses the `mcpConnectLink` minting machinery from PR #157 with a new target.

1. **Mint.** Owner's agent calls `configure_space_share({ slug: "parry-gtm", role: "contributor" })`. The backend mints a Configure-hosted link (`https://configure.dev/spaces/join/<id>`), one row in `space_invites`, hashed token, TTL. Returns the URL for the agent to hand the user. Never caller-constructed.
2. **Open + sign in.** The invitee opens the link and signs in with **their own** Configure account (the existing sign-in flow; new users create an account first).
3. **Accept.** On accept, insert a `space_members` row `(space_id, invitee_user_id, role, granted_by=owner)`. The invite is now `accepted_by` set.
4. **Access.** From then on, the invitee's agents resolve space-scoped access on every `configure_space_*` call for that slug.

## 10. Security: the isolation invariant

**Membership grants access to only that `spaces/<slug>` — never the owner's personal profile, other boxes, or other spaces.** Access is space-scoped, not account-scoped. This is the load-bearing invariant; the feature is unshippable without it.

Enforcement:
- Every `configure_space_*` call resolves the caller against `space_members` for the named `space_id`. No membership row means 403, full stop.
- Reads and writes are constrained to the CFS subtree of that space (path-prefix enforced in `cfsPermissions`, the same layer that already fails closed on connector reads).
- A space-scoped credential (an MCP session claim, in the shape of the existing `mcp_scope_id` scoped-session model) carries the `space_id` set the caller is entitled to. It cannot widen to the owner's profile.
- Nothing from a personal profile ever auto-flows into a space. Writes are explicit `configure_space_write` calls. Reads of a space never traverse into `/agents/<owner>/...` personal namespaces.
- Role gating: `viewer` cannot write; only `owner` can `share`, `members` (revoke), or delete the space.
- Invites expire; owners revoke members; members can leave. Revocation is immediate (next call re-checks `space_members`).

## 11. Attribution model

Every document write stamps `written_by: { user, agent }`, mirroring `mddb`'s `by manuel / claude-code`. This is Configure's existing "attributed testimony" (source-box) model lifted cross-account: when the GTM engineer's agent reads the space, Manuel's Parry notes are attributed to `manuel / parry`, and its own notes to `gtm-eng / their-agent`. No content is presented as unattributed or as Configure-vouched fact inside a space; a space is shared testimony, not a judged profile.

## 12. Discovery: the `spaces` shelf

`profileComposer` already builds the profile-read table of contents from **category**, **source**, and **project** shelves. Add a fourth **`spaces`** shelf: a member's `configure_profile_read` lists the spaces they belong to and their role, so the agent knows the shared context exists and can call `configure_space_read`. Without this, an invited agent never discovers the space. (Refinement 2, defaulted in.)

## 13. Integration points (grounded in current code, main)

- **Storage:** `apps/backend/api/services/cfsService.ts` + `cfsPermissions.ts` (space docs + the permission enforcement point).
- **Invites:** `apps/backend/api/mcp/mcpConnectLink.ts` (add a `space_invite` target next to `signin`/`connections`/`import`).
- **Discovery shelf:** `apps/backend/api/services/profileComposer.ts` (category/source/project shelves at lines ~134/145/174; add `spaces`).
- **Scoped auth:** `apps/backend/dashboard/api/auth.ts` (`mcp_scope_id` scoped-session claim) + `apps/backend/api/middleware/authz.ts` (`resolveExternalUser`), the model a space-scoped credential follows.
- **Tool contract:** `packages/tool-contract/src/tools.ts` (the `configure_space_*` contracts) and `apps/backend/api/mcp/toolTaxonomy.ts` (`NATIVE_MCP_TOOLS`).
- **SDK:** `packages/sdk-typescript/src/` (a `spaces` module + `configure.space(slug)` runtime, mirroring `profile`/`files`).

## 14. Build order (for Devin)

1. **Migrations + model:** `spaces`, `space_members`, `space_invites`.
2. **Space service:** create/read/search/write over CFS with `written_by` + version; membership + role checks; the isolation invariant with tests first (403 on non-member, no path escape).
3. **Invite mint + accept:** extend `mcpConnectLink` with the `space_invite` target; the hosted join page; the accept endpoint that inserts `space_members`.
4. **MCP tools:** `configure_space_*` in the contract + `NATIVE_MCP_TOOLS`, gated by membership/role.
5. **REST routes + SDK methods:** thin delegations to the space service (single-source parity).
6. **Discovery shelf:** `spaces` shelf in `profileComposer`.
7. **Docs:** a `guides/spaces.md` page + reference entries, matching the connect/forget/import docs.

## 15. Testing

- **Isolation (highest priority):** a member of `spaces/A` gets 403 on `spaces/B` and cannot read the owner's personal profile through any space call. Path-escape attempts fail closed.
- **Roles:** viewer write is rejected; contributor write is attributed; only owner can share/revoke/delete.
- **Invite lifecycle:** mint, accept, expiry, revoke, leave; a revoked member's next call fails immediately.
- **Attribution:** every write records the correct `(user, agent)`; a cross-account read shows correct attribution.
- **Parity:** MCP tool, REST route, and SDK method produce identical results (single-source).
- **Concurrency:** section upsert does not clobber; history records versions.

## 16. Out of scope now (future: Configure Orgs)

The full **Org** construct (an Org entity that owns many spaces, member roles at org scope, billing) is the roadmap evolution. Spaces are the primitive Orgs will later group. Do not build Org tenancy now; design the space owner field so an Org can later become the owner without a data migration (owner is a `user_id` today; an Org owner would be an `org_id` — keep the owner reference abstractable).

## 17. Open questions for Manuel

- The four defaulted refinements in section 3 — confirm or veto any.
- Link surface: `configure.dev/spaces/join/<id>` versus routing through the existing `/connect/<id>` page with a space target. (Recommend a dedicated `/spaces/join` page for a clean "join this space" screen.)
- Should a space support non-document short memories too (a space-scoped box), or documents only for v1? (Recommend documents only for v1; add a space box later if needed.)
