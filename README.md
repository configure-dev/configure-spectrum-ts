# Configure SSO for Spectrum message handlers

`@configure-ai/spectrum-ts` adds Configure sign-in and profile access to an existing Photon Spectrum (`spectrum-ts`) message handler.

It resolves the current sender before your handler runs, then provides a Configure profile runtime for the right access state. Approved users can receive personalized responses on the first generated turn. New or unlinked senders get a stable developer-scoped profile and a hosted message sign-in path.

Spectrum continues to own channels, providers, webhooks, message objects, replies, typing, and delivery. This package only adds Configure identity and profile context at the message boundary.

## Capabilities

- **Identity context before the response.** Resolve the sender before model execution, so your first generated reply can use the right identity state.
- **Continuity across supported channels.** When Spectrum exposes a phone-backed sender identifier, the adapter can resolve that sender to the same approved Configure user across supported channels. When a channel only exposes channel-local identifiers, the adapter falls back to a stable developer-scoped user until the sender links with Configure.
- **One profile surface.** Your handler uses `ctx.profile` for linked Configure users and unlinked developer-scoped users, so the agent code can stay consistent while access remains permission-aware.
- **Hosted message SSO.** Generate or send `sign-in.me` links from the message thread. Configure handles verification, consent, connector setup, and agent approval.
- **No Spectrum replacement.** Keep your existing `Spectrum()` app, providers, webhook adapters, and message loop.

## Install

Existing Spectrum apps can add the adapter:

```bash
npm install @configure-ai/spectrum-ts
```

New apps should install Spectrum according to [Photon's docs](https://photon.codes/docs/) before adding this package. If your package manager does not auto-install peer dependencies, install `spectrum-ts` explicitly.

Private preview installs can use a packed tarball until the package is published:

```bash
npm pack
npm install ./configure-ai-spectrum-ts-0.1.0-preview.0.tgz
```

For deployable preview apps, commit the tarball in the consuming repo and reference it with a relative `file:` dependency. Replace that dependency with `@configure-ai/spectrum-ts` after npm publish.

## Existing Handler

```ts
import { withConfigure } from "@configure-ai/spectrum-ts";
import { adapterStore } from "./configure-spectrum-store";

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store: adapterStore,
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

    await message.reply(
      await runAgent({
        message,
        profile,
        linked: ctx.linked,
      })
    );
  });
}
```

`ctx.profile` is built from a linked Configure token when one is available, or from a developer-scoped external user before sign-in. That lets the rest of your agent use one profile runtime while Configure enforces the appropriate access boundary.

When `connect` sends a hosted link, `handle()` returns before the handler runs. The model does not need to decide when to produce Configure sign-in URLs.

`store` persists adapter state between messages: sender mappings, approved Configure tokens, sign-in delivery state, completion journeys, and webhook idempotency. It does not store Configure user memories or profile data. Most apps back this with the same persistence they already use for sessions, users, or webhook idempotency.

For local development and examples:

```ts
const store = withConfigure.localStore();
```

`withConfigure.localStore()` keeps adapter state in the current process. It resets when the worker restarts.

For the design rationale and minting/reconnect implementation plan, see [Message Auth Handoff Spec](docs/message-auth-handoff.md).

## How Resolution Works

For each message, the adapter:

1. Derives stable subject and thread keys from Spectrum `space` and `message` metadata.
2. Reuses a stored Configure token when the sender has already approved this agent.
3. Checks Configure recognition when the channel exposes phone-backed sender identifiers.
4. Falls back to a developer-scoped external user when the sender is not linked.
5. Builds a `ctx` object for your handler before agent logic runs.

Recognition is not authorization. Treat `ctx.linked` as the signal that Configure has an approved agent token for this sender.

## Handler Context

`withConfigure().handle()` gives your existing handler a `ctx` object with:

- `ctx.identity` - the Configure identity result for this sender.
- `ctx.profile` - Configure profile runtime: `read()`, `search()`, `remember()`, tools, and tool execution.
- `ctx.linked` - true only when Configure has an approved agent token.
- `ctx.recognized` - true when Configure recognized sender evidence, even if the user has not approved this agent yet.
- `ctx.signInUrl()` - hosted message sign-in link for the current sender.
- `ctx.replyWithSignIn()` - convenience method for sending the hosted link in-thread.
- `ctx.subject` and `ctx.thread` - stable keys for subject storage and thread-level app state.

## Sign-In Handoff

The adapter can send hosted links before your model runs:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  connect: {
    mode: "intent",
    intent: /\b(connect|link|sign[\s-]?in|login)\b/i,
    sendOnce: true,
    behavior: "send-and-stop",
    message: "Connect your Configure profile: {url}",
  },
});
```

`connect.mode` defaults to `manual`, so the adapter does not send links unless your app opts in. Use `mode: "first-message"` if your product should require Configure sign-in before the first model response.

You can still send a link manually from application code:

```ts
if (!ctx.linked && needsPersonalData(ctx)) {
  await ctx.replyWithSignIn();
  return;
}
```

## Webhook Composition

Compose this adapter inside Spectrum's webhook adapters. Spectrum should handle raw body parsing, signature verification, and provider normalization.

```ts
import express from "express";
import { Spectrum } from "spectrum-ts";
import { spectrum } from "@spectrum-ts/express";
import { withConfigure } from "@configure-ai/spectrum-ts";

const app = await Spectrum({
  webhookSecret: process.env.SPECTRUM_WEBHOOK_SECRET!,
  providers: [],
});

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store,
});

const server = express();

server.use(
  spectrum({
    app,
    onMessage: async (space, message) => {
      await configureSpectrum.handle(space, message, runAgent);
    },
  })
);
```

## Production Checklist

- Use Spectrum's webhook adapters for webhook verification and raw body handling.
- Provide a `store` implementation backed by your app's normal persistence layer.
- Implement `claimMessage()` for webhook idempotency.
- Implement `saveJourney()` and `consumeJourney()` before setting `messageCompleteUrl`.
- Choose a stored-token validation policy and document it.
- Keep `CONFIGURE_API_KEY` server-side.
- Use `CONFIGURE_PUBLISHABLE_KEY` only to build hosted `sign-in.me` URLs.
- Do not log tokens, phone numbers, full message bodies, or webhook headers.
- Do not treat phone recognition as linked access unless Configure returns an approved token.

## Boundaries

- This package does not construct a Spectrum app.
- This package does not re-export Spectrum providers, content builders, webhook adapters, or runtime APIs.
- This package does not parse or verify Photon webhooks.
- This package does not own your model loop, queue, retry worker, or outbound outbox.
- `spectrum-ts` is a peer dependency. Existing apps keep their own compatible Spectrum version.

## Stability

This package is pre-1.0. APIs may change before `1.0`; breaking changes will be documented in `CHANGELOG.md`.
