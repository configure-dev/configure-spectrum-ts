# Configure SSO for Spectrum

`@configure-ai/spectrum-ts` is the Configure adapter for message agents built on Photon Spectrum (`spectrum-ts`).

It gives an existing Spectrum (`spectrum-ts`) handler a resolved user context before your agent runs. Linked Configure users get approved profile access. New or unlinked senders get a stable developer-scoped profile and a hosted message sign-in path.

Spectrum continues to own channels, providers, webhooks, message objects, replies, typing, and delivery. This package only adds Configure identity and profile context at the message boundary.

## What You Get

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

## Use It In An Existing Handler

```ts
import { memoryStore, withConfigure } from "@configure-ai/spectrum-ts";

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store: memoryStore(), // Local development only. Use a durable store in production.
});

for await (const [space, message] of app.messages) {
  await configureSpectrum.handle(space, message, async (ctx) => {
    const { profile } = await ctx.profile.read();

    await message.reply(
      await runAgent({
        message,
        profile,
        linked: ctx.linked,
        signInUrl: await ctx.signInUrl(),
      })
    );
  });
}
```

`ctx.profile` is built from a linked Configure token when one is available, or from a developer-scoped external user before sign-in. That lets the rest of your agent use one profile runtime while Configure enforces the appropriate access boundary.

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

Use manual sign-in when your agent decides the sender should connect:

```ts
if (!ctx.linked && needsPersonalData(ctx)) {
  await ctx.replyWithSignIn();
  return;
}
```

You can also configure first-message or intent-based prompts:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  connect: {
    mode: "intent",
    intent: /\b(connect|link|sign[\s-]?in|login)\b/i,
  },
});
```

`connect.mode` defaults to `manual` so the adapter does not send links unless your app asks it to.

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
- Provide a durable `store` implementation for subject records and Configure tokens.
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
