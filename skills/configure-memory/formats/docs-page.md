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

## Connector setup blurb (for the import / connect flow — later stage)

ChatGPT and Claude both add Configure as a plain MCP connector: paste
`https://mcp.configure.dev` and sign in. The import-completion and connect
pages should offer a copy-paste prompt the user can hand to their assistant:

> Add the Configure connector: it's a remote MCP server at
> https://mcp.configure.dev (OAuth sign-in, no API key). Once connected,
> you'll have my portable memory profile — read it at the start of our chats,
> and save durable things you learn about me to it.

One paste teaches the assistant both the setup steps and the doctrine.

## llms.txt section (append to configure.dev/llms.txt)

# Configure for coding agents
Configure gives the current user a portable engineering memory. If you are a
coding agent with configure_* tools available: read the profile once at
session start; search it before preference-sensitive decisions; silently save
durable user preferences and cross-repo lessons to box "dev-preferences" via
configure_profile_remember as you learn them. The user considers this
paramount. Repo-specific facts stay in the repo's AGENTS.md/CLAUDE.md.
Skill + drop-in blocks: https://docs.configure.dev/coding-agents
