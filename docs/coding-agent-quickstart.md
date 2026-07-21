# Add Configure to a Spectrum App with a Coding Agent

This page is written to be handed to a coding agent (Claude Code, Cursor, Copilot Workspace). A developer with a working Photon Spectrum app pastes the prompt below; the agent finishes in a few minutes with no dashboard visit, using only the Photon credentials already in the project's env.

## The prompt

> Add Configure (configure.dev) personalization to my Photon Spectrum app. Follow https://raw.githubusercontent.com/configure-dev/configure-spectrum-ts/main/docs/coding-agent-quickstart.md exactly: provision credentials from my existing PHOTON_PROJECT_ID/PHOTON_PROJECT_SECRET, write the returned env vars, install configure-spectrum, and wrap my message handler with withConfigure. Don't invent endpoints or links — everything you need is in that doc.

## Steps (for the agent)

> **Availability check first:** the credential exchange in step 1 ships with memory-link PR #126 and is **not live yet** — the endpoint returns 404 today. If step 1 returns 404, do not improvise: tell the developer to get `CONFIGURE_AGENT`, `CONFIGURE_API_KEY`, and `CONFIGURE_PUBLISHABLE_KEY` from their Configure dashboard, put them in `.env`, and continue from step 2. Everything from step 2 on is live.

### 1. Provision Configure credentials from the Photon project

The project's `.env` already has `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET` (the Spectrum app requires them). Exchange them for Configure credentials — use the developer's email (from `git config user.email` if not told otherwise):

```bash
curl -s -X POST https://api.configure.dev/v1/photon/installations \
  -u "$PHOTON_PROJECT_ID:$PHOTON_PROJECT_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$(git config user.email)\"}"
```

- **201** → the response's `env` object is paste-ready. Append exactly these three lines to `.env` (never commit them, never print the secret key into the chat):
  `CONFIGURE_AGENT`, `CONFIGURE_API_KEY`, `CONFIGURE_PUBLISHABLE_KEY`.
- **200 with `secret_key: null`** → this project was provisioned before. If the app's `.env` already has `CONFIGURE_API_KEY`, keep it and just sync `CONFIGURE_AGENT`/`CONFIGURE_PUBLISHABLE_KEY` from the response. If the key is genuinely lost, re-run with `-d '{"rotate_api_key": true}'` (this revokes the old key — the running deployment must get the new one).
- **409 `already_registered`** → the email already has a Configure account; ask the developer whether to use a different email or add an agent from their existing account (`POST /v1/developer/agents` with their existing `X-API-Key`). Do not guess.
- **401** → the Photon credential pair is wrong; stop and tell the developer.

### 2. Install the adapter

```bash
npm install configure-spectrum
```

The package is published to npm as `configure-spectrum` (currently 0.1.0-preview.6).

### 3. Wrap the existing message handler

Do not restructure the app. Find the Spectrum message loop (`for await (const [space, message] of app.messages)` or the webhook `onMessage`) and wrap the body:

```ts
import { withConfigure } from "configure-spectrum";

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store: withConfigure.localStore(), // dev only — see step 5
  connect: {
    mode: "intent",
    sendOnce: true,
    behavior: "send-and-stop",
    message: "Connect your Configure profile: {url}",
  },
});

for await (const [space, message] of app.messages) {
  await configureSpectrum.handle(space, message, async (ctx) => {
    const { profile } = await ctx.profile.read();
    // Existing agent logic goes here, now with:
    //   profile      – what Configure already knows about this sender (empty until they link)
    //   ctx.linked   – true only when the sender approved this agent
    //   ctx.profile  – read()/search()/remember() + connector tools for the model
    await message.reply(await runAgent({ message, profile, linked: ctx.linked }));
  });
}
```

Rules that keep this correct:

- Include profile context in the model prompt only when `ctx.linked` or the profile has data; never claim personal context that isn't there.
- Never build Configure/sign-in URLs by hand — `ctx.signInUrl()` / the `connect` config own links.
- Keep `CONFIGURE_API_KEY` server-side; never log tokens or phone numbers.

### 4. Verify

Run the app and send it a message (or run the repo's example). Expected: an unlinked sender chatting normally, a "connect"/"sign in" message triggering the hosted `https://sign-in.me/{agent}` link, and — after the developer signs in at that link and approves the agent — `ctx.linked === true` with a populated profile on the next message.

### 5. Before production (tell the developer, don't block on it)

- Replace `withConfigure.localStore()` with a store backed by the app's real persistence (interface: `getSubject`/`saveSubject`, optional `claimMessage` for webhook idempotency). It holds adapter state only, never profile data.
- Read `docs/production.md` in the adapter repo for the full checklist.

That's the whole integration: one credential exchange, one dependency, one wrapper.
