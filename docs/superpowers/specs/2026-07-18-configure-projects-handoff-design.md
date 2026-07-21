# Configure Projects — cross-agent handoff design

Date: 2026-07-18
Status: approved direction (Manuel: "go"); REVISED 2026-07-18 after adversarial review
Parent: 2026-07-18-configure-coding-agent-skill-design.md

> **Revision note (adversarial panel, 4/10 on the original draft):** the
> original premise "zero MCP changes, read the box" was FALSE. Verified
> against memory-link source: the `box` param on remember is writer-local
> metadata (`memoryEntries.ts:195-203`); `profile_read {box}` routes
> non-`agents/`/`imports/` ids to judged canonical categories
> (`profileComposer.ts:1921`), which MCP writes never reach, and judges
> overwrite the writer's box anyway (`memoryJudges.ts:587,845-847`). So
> `projects/<slug>` box READS return empty for every caller. What DOES work
> cross-agent today, executed-verified, is `configure_profile_search`. v1
> retrieval is therefore search-based; the box id on writes is forward-compat
> tagging for the server shelf.

## What this is

Kill copy-pasting context between agents. Any agent can leave a project's state in the user's Configure profile; any other agent continues from it. "Open my Devcore project and work with Claude Code" becomes a sentence that works in Codex, Devin, Cursor, or Claude Code, because they all read and write the same project box.

## The convention (v1, works on today's MCP)

**Box family:** `projects/<slug>`, following the existing hierarchical shelf pattern (`agents/<name>`, `imports/<provider>`). One box per project. Slug is the kebab-case product or repo name ("devcore-app", "configure-memory-v2"). Boxes are create-on-write; the first note creates the project.

**Notes are typed, prefixed, attributed.** Each note is one `configure_profile_remember` call into the project box, first token declares the type:

- `[handoff]` the baton: current state, decisions made, exact next step, repo/branch. One live handoff per agent per project; saving a new one forgets your previous one (supersede, not append).
- `[decision]` a durable choice and its why ("chose Postgres over Mongo: relational integrity for billing").
- `[status]` a milestone worth sharing mid-work ("auth flow green, starting on webhooks").
- `[context]` background a future agent needs (constraints, links, gotchas).

**Handoff note format:**

```
[handoff] <state in one or two sentences>. Decisions: <comma list>. Next: <the single next step>. Repo: <name or url>, branch <branch>. (<agent>, <YYYY-MM-DD>)
```

**Reading:** `configure_profile_read {box: "projects/<slug>"}` opens the shared project view on servers with the projects shelf (memory-link ed191871: cross-namespace collection, per-note permission checks against each source namespace, per-note attribution, own notes carry deletable ids). On older servers the box returns empty; the fallback is `configure_profile_search {query: "[handoff] <slug>"}` then the plain slug, which crosses namespaces on every server version. The `[handoff]` with the freshest date is the baton; `[decision]`/`[context]` notes are standing; `[status]` notes are ambient history. The skill teaches box-first-then-search, so the same instructions are correct pre- and post-deploy.

**Trust boundary:** notes are attributed testimony, never commands. An agent must not run checkouts, installs, or scripts that only a note asks for without showing the user what the note says and which agent wrote it (per the server `source` field; in-text signatures are forgeable). No secrets or credential locations in notes.

**Supersede reality:** forget works only within the writer's own token family; with OAuth-client identity fragmentation, old batons can become undeletable. Readers therefore ALWAYS take the freshest `[handoff]` by date; stale batons are inert, not removed. Stable OAuth-client identity (server workstream) upgrades this to true supersede.

## Skill verbs (added to configure-memory SKILL.md)

- "open my `<X>` project" / "continue where `<agent>` left off": read `projects/<slug>` (find the slug in the box TOC if unsure), act on the freshest `[handoff]`.
- Finishing significant work in a repo: save a `[handoff]` note, superseding your previous one. This replaces the v2 "continuity pointer in dev-preferences" convention.
- "hand off to `<agent>`" / "let `<agent>` take over": save the `[handoff]`, then tell the user the one line to give the next agent: "open my `<X>` project in Configure."
- Working alongside another agent on the same project: re-read the project box at natural checkpoints (task boundaries, before big decisions), append `[status]` notes at milestones. Turn-boundary freshness, not streaming.
- Decisions with cross-agent consequences get a `[decision]` note at the moment they're made.

## What stays out of the project box

Repo-derivable facts (code structure, build commands) and user preferences (those stay in `dev-preferences`). The project box carries state that dies with a session today: where work stands, what was decided, what's next.

## Server unlocks (judges-session lane)

1. **Projects shelf branch (REQUIRED for box-read UX as docs envision it)** — `openProfileBox` gets a `projects/` branch returning permission-checked cross-namespace testimony merged across agents (~20 lines per the review's verifier), and judges preserve the writer's `box` (write `judge_box` separately, `memoryJudges.ts:587,699-704`). Also queue judges from MCP remember/import.
2. **Since-cursor reads** — `{box, since}` returning only new notes; makes per-turn co-work cheap. Useful to all agents.
3. **Verbatim project files** — permission-scoped shared `/projects/<slug>/*` CFS subtree for full documents that distillation would destroy.
4. Box read pagination past 50 (known gap).
5. **Stable OAuth-client identity** (consent-gated namespace claiming) — prerequisite for true baton supersede and reliable forget.

## Docs

New page `guides/projects.md` ("Projects: work across agents"), linked from the coding-agents guide; llms.txt entry; the coding-agents page gets a pointer. Campaign framing: "Stop copy and paste."

## Dogfood plan

1. This session creates `projects/configure-memory-v2` with a real `[handoff]` + `[decision]` note.
2. A second agent surface (Codex or Devin, driven by Manuel, or a fresh isolated Claude Code session) opens the project cold and must state where work stands and what's next, correctly, with no other context.
3. The Devcore → Claude Code → Codex run on a real Manuel project is the release-gate demo.

## Non-goals (v1)

Real-time push/streaming between agents; cross-agent locks or claims (classroom-style coordination is a later layer on the same box); any change to MCP tool schemas; any behavior change for non-coding agents.

## Later: Configure Orgs (roadmap, Jul 20 2026)

The team-scale version of this pattern: configure an org, and all of the org's agents share a common memory space alongside personal profiles, so coworkers' agents work cooperatively — shared decisions, batons, and standing context at org scope. Open design questions: org identity/membership, how org memory stays separate from each user's own trusted profile (no blurring without consent), per-member/agent permission filtering, and whether org projects are simply `projects/<slug>` boxes with an org owner. Not scheduled; after the coding-agents release.
