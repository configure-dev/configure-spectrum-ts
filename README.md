# Configure SSO for Spectrum message handlers

`@configure-ai/spectrum-ts` adds Configure sign-in and profile access to an existing Photon Spectrum (`spectrum-ts`) message handler.

It resolves the current sender before your handler runs, then provides a Configure profile runtime for the right access state. Approved users can receive personalized responses on the first generated turn. New or unlinked senders get a stable developer-scoped profile and a hosted message sign-in path.

Spectrum continues to own channels, providers, webhooks, message objects, replies, typing, and delivery. This package only adds Configure identity and profile context at the message boundary.

## Capabilities

- **Identity context before the response.** Resolve the sender before model execution, so your first generated reply can use the right identity state.
- **Continuity across supported channels.** When Spectrum exposes a phone-backed sender identifier, the adapter can resolve that sender to the same approved Configure user across supported channels. When a channel only exposes channel-local identifiers, the adapter falls back to a stable developer-scoped user until the sender links with Configure.
- **One profile surface.** Your handler uses `ctx.profile` for linked Configure users and unlinked developer-scoped users, so the agent code can stay consistent while access remains permission-aware.
- **Hosted message SSO.** Generate or send `sign-in.me` links from the message thread. Configure handles verification, consent, connector setup, agent approval, and message return behavior when Spectrum exposes a reliable target.
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

Hosted links use Configure's public `sign-in.me/{agent}` surface, so the model never needs to construct Configure URLs. If your app passes `signIn.agentPhone`, that explicit app-bound line is used first. Otherwise, for Spectrum iMessage dedicated-line spaces, the adapter reads Spectrum's routed line from `space.phone` and uses it when it is a valid E.164 phone number. Shared-mode sentinels such as `shared`, blank local-mode values, and other non-phone values are ignored, so Configure falls back to the normal hosted completion path instead of receiving an unreliable return phone.

If Photon exposes the agent's current return line through an API instead of `space.phone`, pass an async resolver:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent: "your-agent",
  store,
  signIn: {
    agentPhone: async (ctx) => photon.lines.currentPhone({ spaceId: ctx.space.id }),
  },
});
```

Set `signIn.linkMode` to `"auto"` to route message sign-in through Configure's message URL API. When a return line is available, the adapter registers that line for the configured agent before requesting the URL. Configure returns the hosted fallback when signed subject evidence is missing or unsupported, and reserves code-bearing links for verified message subjects.

`store` persists adapter state between messages: sender mappings, approved Configure tokens, sign-in delivery state, completion journeys, and webhook idempotency. It does not store Configure user memories or profile data. Most apps back this with the same persistence they already use for sessions, users, or webhook idempotency.

For local development and examples:

```ts
const store = withConfigure.localStore();
```

`withConfigure.localStore()` keeps adapter state in the current process. It resets when the worker restarts.

For the design rationale and message URL/reconnect implementation plan, see [Message Auth Handoff Spec](docs/message-auth-handoff.md).

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
- `ctx.reconnectUrl({ connectors })` - hosted reconnect link for refreshing a specific app connection.
- `ctx.replyWithReconnect({ connectors })` - convenience method for sending a reconnect link in-thread.
- `ctx.subject` and `ctx.thread` - stable keys for subject storage and thread-level app state.

## Sign-In Handoff

The adapter can send hosted links before your model runs:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  signIn: {
    linkMode: "auto",
  },
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

## Message Return Behavior

Developers should not need to know Configure hosted URL parameters to return a user to the same message channel after sign-in. The adapter infers that from the current Spectrum `space` and `message` when Spectrum exposes a reliable target.

For iMessage dedicated-line spaces, Spectrum includes the routed sending line on `space.phone`. When no explicit `signIn.agentPhone` is configured and that value is a valid E.164 phone number, the adapter passes it to Configure for sign-in and reconnect links. In shared iMessage mode, local mode, or channels without a reliable message return target, the adapter omits the return phone and keeps the hosted Configure completion fallback.

`signIn.agentPhone` is the explicit app-bound return line. It can be a string or an async resolver that calls Photon for the current line. The resolved value is validated as E.164; values such as `shared` are ignored rather than sent to Configure.

In `linkMode: "auto"`, valid return lines are registered through Configure before the adapter asks for a message URL. If registration fails, the adapter omits the return phone and keeps the hosted sign-in path usable.

You can still send a link manually from application code:

```ts
if (!ctx.linked && needsPersonalData(ctx)) {
  await ctx.replyWithSignIn();
  return;
}
```

When a Configure-backed tool reports that provider access needs to be refreshed, send a targeted reconnect link from application code:

```ts
await ctx.replyWithReconnect({
  connectors: ["gmail"],
  message: "Reconnect Gmail so I can keep helping with email: {url}",
});
return;
```

Reconnect links use the same hosted surface as sign-in, but they only refresh the requested app connection. In `linkMode: "auto"`, the adapter asks Configure for a message URL and accepts the plain hosted reconnect URL unless verified Spectrum subject evidence allows a code-bearing link.

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
- Keep `CONFIGURE_PUBLISHABLE_KEY` browser-safe; the adapter's default plain message link does not need to expose it in the URL.
- Pass `signIn.agentPhone` when your app has an authoritative line binding; otherwise let the adapter infer iMessage return lines from Spectrum `space.phone` when possible. Do not pass shared-mode sentinels as phone numbers.
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
