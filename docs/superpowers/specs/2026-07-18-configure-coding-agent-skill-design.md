# Configure for Coding Agents — configure-memory v2 design

Date: 2026-07-18
Status: approved direction, pending Manuel's spec review
Research inputs: 11-agent workflow (9 briefs + synthesis + adversarial critique), session scratchpad

## What this is

A portable always-write doctrine, not just a skill. Any coding agent a Configure user works with should learn one pattern: as you work, you learn things about the user; continuously and silently save them to the user's Configure profile, and re-read for updates at natural checkpoints. No invocation required, no asking permission per save, no narrating saves. The skill file is one delivery format of that doctrine.

## Core loop (the doctrine)

1. **Ground at session start.** Read the profile (digest injection on Claude Code via hook; directive instruction elsewhere). Know who the user is, their dev preferences, and what other agents learned.
2. **Precheck at decision time.** Before preference-sensitive choices (package manager, framework, test runner, formatter, commit/PR style, scaffolding), search the profile. Never claim something about the user is "not on file" without searching.
3. **Write as you learn.** The moment a durable preference, style signal, or cross-repo lesson surfaces, save it. Silent, one fact per save, filed into the `dev-preferences` box (namespace-level; promotion to canonical is the judge pipeline's job, out of scope here).
4. **Re-read for updates.** At natural checkpoints (compaction recovery, long-session milestones), check `changesSince` / own box for updates from this or other agents.
5. **Commit at milestones.** Task completion, pre-compaction, and on `-32009 commit_required`: commit with an honest one-line summary, retry the read.

## Routing rule (what goes where)

- Teammate cloning the repo would need it → CLAUDE.md / AGENTS.md.
- This user would want it on a new machine, new repo, or in another agent → Configure (`dev-preferences` box).
- Neither would want it next week, or it's derivable from the codebase → save nowhere.
- Margin examples in the skill body: "this repo uses pnpm" → repo; "I prefer pnpm everywhere" → Configure.

## Write policy

- Full auto-save. User-stated facts save immediately. Inferred lessons (library gotchas, architecture decisions, recurring bugs) auto-save with attribution (date, repo, library version) and one rubric line: "will a future session in a different repo act differently because of this?" Soft budget ~5 inferred saves/session.
- Silent UX. Never ask "want me to save this?", never announce routine saves. Forget/delete requests are still confirmed in one line (consent surface).
- One per-repo continuity pointer fact ("working on <repo>: state, next step, date"), superseded not appended.
- Prompt-able bulk export: "save everything you know about me" → distill session knowledge, save via import/remember batch.
- Failed forget (foreign token family): tell the user plainly, point at the Configure UI. Never fail silently.

## Delivery formats

1. **SKILL.md + install (Claude Code, first target).** Replaces v1 in place. First run installs read-only hooks:
   - SessionStart (startup/resume/compact): inject digest ≤800 tokens — identity, dev-preferences kernel, box TOC, freshest own-namespace facts, `self.id`. Index not content outside the dev kernel. Fail-soft: 2s timeout, silent skip, never blocks session start.
   - PreCompact: nudge only ("commit and save durable state now"); the model does the writes.
   - Hooks never write to the profile (writes require a model turn). Auth reuses Claude Code's existing Configure MCP credential; if unavailable, degrade to a "read your profile now" nudge. No second OAuth client.
2. **AGENTS.md drop-in block** for Codex/Cursor/Devin/anything: the doctrine in ~30 lines, directive form.
3. **llms.txt + docs page** on configure.dev/docs: the doctrine, the routing rule, the block to copy.
4. **Adoption nudges:** connect/import flow tells the user "your agent can pick up the Configure skill"; import completion message links the formats.

## Description / trigger design (skill format)

- Two variants: hook-installed (drops the session-start directive the hook already satisfies; covers judgment moments only) and fallback (carries session-start directive for hook-less harnesses).
- Directive form with negative constraint: "Do NOT pick a convention default, answer questions about the user, or claim something is not on file without searching the profile."
- Excluded triggers: "review this PR", "fix this failing test" (high frequency, mostly impersonal; false-positive trainers).

## Evals (gate for shipping and for MCP changes)

1. RED baseline: 8–12 pressure scenarios without the skill; harvest verbatim rationalizations into the skill's red-flag table.
2. In-agent tool-call evals (Claude Code first, then Codex-class): call rate at should-call moments, false-call rate, save quality. Targets: ≥95% should-fire, ≤5% false-positive.
3. Outcome benchmark with/without: right-convention-chosen, gotcha-precheck-fired, junk-not-saved, privacy-leak grader (no personal fact in output/commits/PRs), pollution grader (fraction of saves passing the routing rule retroactively).
4. MCP surface changes are decided AFTER these evals show need. Candidates parked: digest read shape, search recency ordering, response de-dupe, commit-wall re-scope, stable OAuth-client identity (consent-gated claiming, never trust client_name).

## Out of scope for v2

- Judge pipeline changes (another session owns judges).
- SessionEnd/headless unattended capture (v3, needs explicit opt-in consent story).
- Per-repo project-state boxes beyond the single pointer fact (needs server pagination/upsert).
- Cross-agent write mediation (read-mostly), semantic search, batch ops.

## Known risks carried consciously

- Identity fragmentation: fresh OAuth clients mint new namespaces (`agents/mcp-<hash>`); forget fails across token families. Skill reads `self.id` at start, never hardcodes a name; server fix parked behind evals.
- MCP writes currently bypass judges, so agent saves live in the namespace only; the doctrine reads own-box/source-filtered, not canonical, for its own writes. Judges are the other session's lane.
- Full auto-save without an enforcing admission gate can accumulate junk; mitigations are the rubric line, attribution fields, soft budget, and the pollution grader in evals.
