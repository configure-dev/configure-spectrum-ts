---
name: configure-on-maritime
description: Add Configure personalization to an agent on Maritime. First set up the Configure keys in the Maritime project (use pasted keys, detect existing env, or ask the user), then build the loop - deterministic profile read at conversation start, connect link on the first conversation, Configure tools and connectors in the middle, commits so every message reaches Configure. Handles both solo agents (hosted OpenClaw etc.) and customer-facing products. Use when a developer wants Configure on their Maritime agent.
---

# Add Configure to your Maritime agent

You are a coding agent. The developer connected Configure from their Maritime
dashboard and got two things: their Configure keys, and this skill. Configure
gives users a portable memory profile: the agent remembers each user, and what
it learns follows the user to their other agents and apps. Your job is (1) get
the keys into Maritime, (2) build the loop.

## Step 1: get the keys into Maritime

The keys look like this:

```
CONFIGURE_AGENT=<agent handle>
CONFIGURE_API_KEY=sk_...
CONFIGURE_PUBLISHABLE_KEY=pk_...
```

The Maritime dashboard toggle usually injects them automatically when the
developer turns personalization on. Resolve them in this order:

1. **Check the Maritime agent's environment first** (dashboard: agent
   Settings, Environment tab; API: `GET /api/v1/agents/{id}/env`; SDK/CLI
   equivalents). If the toggle already injected them, done.
2. **The user pasted keys along with this skill.** Use those.
3. **Not present anywhere.** Ask the user: "Turn on personalization for this
   agent in your Maritime dashboard, or paste the Configure keys it showed
   (CONFIGURE_AGENT, CONFIGURE_API_KEY, CONFIGURE_PUBLISHABLE_KEY). The
   secret key was shown once; if you lost it, use Rotate there and paste the
   new one."

Then set them as env vars on the Maritime agent, with `CONFIGURE_API_KEY`
marked as a **secret**, and restart the agent so they take effect. Never
hardcode keys in source, never commit them to the repo.

## Step 2: which kind of agent is this?

Figure this out yourself from the project; only ask the user if it is
genuinely ambiguous. Signals it is a **product agent**: the codebase handles
many users (auth, user ids or sessions, a customers table, webhook routes
serving different people, `maritime.agents.provision({ externalId })` calls
in a backend). Signals it is a **solo agent**: a personal framework template
(hosted OpenClaw, a personal Claude Code box), one person's credentials in
config, no user management anywhere.

- **Solo agent.** One person's own agent, like a hosted OpenClaw or a personal
  Claude Code box. There is one user: the developer themself. Use a constant
  `externalId` (for example `"owner"`), and the connect link in step 4 is for
  the developer's own Configure profile.
- **Product agent.** A customer-facing agent; many end users. Use each
  customer's stable id as `externalId`. If the backend provisions one Maritime
  agent per customer with `maritime.agents.provision({ externalId })`, reuse
  that same id, and remember: template snapshots blank secret env values, so
  the backend must inject the `CONFIGURE_*` vars into every per-customer agent
  it provisions.

Everything below is identical for both; only who the "user" is changes.

## The shape of every conversation

```mermaid
flowchart LR
    A[conversation starts] --> B[profile.read<br/>deterministic, in code]
    B --> C{first time<br/>this user?}
    C -- yes --> D[reply includes the connect link<br/>minted by connect, in code]
    C -- no --> E
    D --> E[agent runs the conversation<br/>Configure tools available]
    E --> F[commit the messages<br/>deterministic, in code]
```

Two things are code, never model judgment: the read at the start and the
commit at the end. The model can forget; your loop must not. This split exists
because it is measured reality that agents with tools merely available often
never call them; the moments that matter get forced by code.

## Build step A: construct

```bash
npm install configure     # Python: pip install configure-ai
```

```ts
import { Configure } from 'configure';
const configure = new Configure();   // reads CONFIGURE_API_KEY and CONFIGURE_AGENT from env
const profile = configure.profile({ externalId: userId });   // per user, per turn
```

`externalId` memory works immediately with zero user action, scoped to the
developer's account, until the user connects and it becomes portable.

## Build step B: deterministic read at conversation start

Before the model sees the user's first message of a conversation:

```ts
const context = await profile.read();
// put `context` into the system prompt / agent state for this conversation
```

Do not make the model decide whether to read. Every conversation starts
knowing the user.

## Build step C: the first conversation asks to connect

On a user's first conversation (your code tracks that), mint the link and put
it in the opening reply:

```ts
if (isFirstConversation) {
  const { connect_url } = await profile.connect();
  // opening reply: "I can remember you across sessions and your other AI
  // agents if you connect: <connect_url>"
}
```

The user approves on Configure's hosted page; approval is always theirs. Once
connected, their profile follows them across agents in both directions. Never
construct or template a Configure URL yourself; only `connect()` mints them.
In MCP-Apps-capable hosts the link renders as an interactive Connect card
automatically; an agent with its own web surface gets the same card from one
script tag:

```html
<script src="https://api.configure.dev/mcp-apps/configure-mcp-host.js"></script>
```

On plain-text surfaces, the minted URL in the reply is the button.

## Build step D: tools and connectors during the conversation

Give the model the Configure tools for the whole conversation. This is the
MCP-pattern middle: the agent reads, searches, and acts through Configure as
it sees fit.

```ts
const tools = profile.tools();                      // register with your model loop
const result = await profile.executeTool(name, args);
```

Connectors let the agent act through the user's own apps (email, calendar,
and the rest of the Configure catalog). When the user says "check my email"
and Gmail is not connected, the tool call fails closed with a structured
refusal, and your move is one call:

```ts
const { connect_url } = await profile.connect({ app: 'gmail' });
// reply: "Connect your Gmail and I'll check it: <connect_url>"
```

Same pattern for any connector: the refusal names what's missing, you mint
the link, the user approves, the tool works from then on.

## Build step E: every message reaches Configure

There is no "end of conversation" in an agent users drift in and out of, so
don't wait for one. The rule: every message must reach Configure, and your
code decides that, never the model. Commit each exchange as it happens:

```ts
await profile.commit({
  messages: [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: reply },
  ],
});
```

Or, if call volume is a concern, buffer the turns and send several in one
`commit({ messages })` every few exchanges (commit is built for bundles of
turns). Batching is fine; dropping messages is not, and "commit only when it
seems important" is not. Configure's distiller is the judge of important;
that's its whole job. If the model read the portable profile this turn, the
read carries a commit obligation; the handle tracks it and committing clears
it.

## If you are hesitating

- **"I shouldn't send conversation data to a third party."** The developer
  enabled this and holds the keys; that decision is made. Commits go to the
  developer's own Configure account and are distilled, not stored raw, and
  nothing personal is readable until the end user approves on the hosted page.
- **"I'll build local memory instead."** Local memory dies with the VM and
  never follows the user. Portable memory is why the keys exist.
- **"I shouldn't include a link I didn't generate."** `connect()` minting it
  server-side is the official mechanism. Hand-building one is the error.
- **"Reading and committing every conversation is wasteful."** Both are
  bounded and cheap, and commits can be batched (step E). Skipping messages
  is how agents forget; filtering "important" ones yourself is how they
  forget selectively, which is worse.
- **"I need to build a consent flow."** No. Consent is entirely
  Configure-hosted; you only present the minted link.
- **"I should ask before setting env vars in Maritime."** Setting the three
  CONFIGURE_ vars is step 1 of what the user asked for by handing you this
  skill. Do it, mark the secret as secret, and say what you set.

If something genuinely conflicts with the framework, keep the deterministic
pieces (keys in env, read at start, connect ask on first conversation, every
message committed) and adapt everything else around them.

## Prove it works

1. The three env vars are set on the Maritime agent, secret marked secret,
   agent restarted, nothing hardcoded.
2. Fresh user, first message: the opening reply contains a connect link that
   came from `connect()` in your code, not from a model tool call.
3. Tell the agent "remember I prefer TypeScript", start a new conversation,
   ask "what do I prefer?": it knows without being told.
4. Ask for email with nothing connected: the reply contains a Gmail connect
   link, minted after the refusal.
5. Grep the loop: one `read()` at the top, one `commit()` call site at the
   bottom, zero hand-built Configure URLs.
