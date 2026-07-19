# Configure Projects — cross-agent handoff design

Date: 2026-07-18
Status: approved direction (Manuel: "go"), v1 is convention-only, zero MCP changes
Parent: 2026-07-18-configure-coding-agent-skill-design.md

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

**Reading:** `configure_profile_read {box: "projects/<slug>"}` returns the notes, attributed per agent with dates. The freshest `[handoff]` is the baton; `[decision]`/`[context]` notes are standing; `[status]` notes are ambient history.

## Skill verbs (added to configure-memory SKILL.md)

- "open my `<X>` project" / "continue where `<agent>` left off": read `projects/<slug>` (find the slug in the box TOC if unsure), act on the freshest `[handoff]`.
- Finishing significant work in a repo: save a `[handoff]` note, superseding your previous one. This replaces the v2 "continuity pointer in dev-preferences" convention.
- "hand off to `<agent>`" / "let `<agent>` take over": save the `[handoff]`, then tell the user the one line to give the next agent: "open my `<X>` project in Configure."
- Working alongside another agent on the same project: re-read the project box at natural checkpoints (task boundaries, before big decisions), append `[status]` notes at milestones. Turn-boundary freshness, not streaming.
- Decisions with cross-agent consequences get a `[decision]` note at the moment they're made.

## What stays out of the project box

Repo-derivable facts (code structure, build commands) and user preferences (those stay in `dev-preferences`). The project box carries state that dies with a session today: where work stands, what was decided, what's next.

## Server unlocks (later, judges-session lane; not required for v1)

1. **Since-cursor box reads** — `read {box, since}` returning only new notes; makes per-turn co-work cheap. Useful to all agents, not just coding.
2. **Verbatim project files** — permission-scoped shared `/projects/<slug>/*` CFS subtree over the existing file layer, for full documents (specs, long transcripts) that distillation would destroy. Boxes stay the notes layer; files become the artifact layer.
3. Box read pagination past 50 (already a known gap).

## Docs

New page `guides/projects.md` ("Projects: work across agents"), linked from the coding-agents guide; llms.txt entry; the coding-agents page gets a pointer. Campaign framing: "Stop copy and paste."

## Dogfood plan

1. This session creates `projects/configure-memory-v2` with a real `[handoff]` + `[decision]` note.
2. A second agent surface (Codex or Devin, driven by Manuel, or a fresh isolated Claude Code session) opens the project cold and must state where work stands and what's next, correctly, with no other context.
3. The Devcore → Claude Code → Codex run on a real Manuel project is the release-gate demo.

## Non-goals (v1)

Real-time push/streaming between agents; cross-agent locks or claims (classroom-style coordination is a later layer on the same box); any change to MCP tool schemas; any behavior change for non-coding agents.
