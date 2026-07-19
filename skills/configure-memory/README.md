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
silent no-op; unreachable or stale token → one-line nudge (the model then
reads the profile through MCP, which refreshes the token); never blocks the
session.

## Other agents

- `formats/AGENTS-block.md` — paste into AGENTS.md / system prompt.
- `formats/docs-page.md` — docs.configure.dev + llms.txt drafts, plus the
  connector-prompt blurb for the import/connect flow.

## Evals

```bash
node evals/run.mjs --label <name> --cwd <project-with-configure-mcp>
```

Runs the scenarios headless via `claude -p`, counts `mcp__configure__*` tool
calls, and writes `evals/results/<label>.json`. Should-fire target ≥95%,
should-not-fire clean ≥95%.

## Layout

- `SKILL.md` — the doctrine (Claude Code skill format)
- `engine/` — credential discovery, MCP client, digest composer (zero-dep)
- `hooks/session-start.mjs` — SessionStart entrypoint
- `install.mjs` — idempotent installer

## Known limits (v2, by design)

- Hook reads reuse Claude Code's stored Configure token; if it has rotated,
  the hook degrades to the nudge for that session.
- Agent writes land in the agent's namespace (`agents/<self>`); promotion to
  canonical boxes is the judge pipeline's job (server-side workstream).
- Unattended/headless end-of-run capture is deferred to v3 (needs an explicit
  consent story).
