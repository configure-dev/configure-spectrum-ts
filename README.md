# Configure SSO for Spectrum message handlers

`configure-spectrum` adds Configure sign-in and profile access to an existing Photon Spectrum (`spectrum-ts`) message handler.

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
npm install configure-spectrum
```

New apps should install Spectrum according to [Photon's docs](https://photon.codes/docs/) before adding this package. If your package manager does not auto-install peer dependencies, install `spectrum-ts` explicitly. This package depends on `configure@^1.1.16` for the profile runtime plus hosted message URL, hosted completion, message-line registry, and sender-proof fallback helpers.

## Credentials: provision from your Photon project

You do not need a Configure signup to get `CONFIGURE_API_KEY`, `CONFIGURE_PUBLISHABLE_KEY`, and `CONFIGURE_AGENT`. A Spectrum app already holds `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET` — exchange them once:

```bash
curl -s -X POST https://api.configure.dev/v1/photon/installations \
  -u "$PHOTON_PROJECT_ID:$PHOTON_PROJECT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

Configure verifies the pair against Photon's own `getProject` (control of the project is the proof), creates the developer account + agent + keys, and returns a paste-ready `env` block. The call is idempotent per project; the secret key is shown once (`rotate_api_key` mints a replacement). Details: [Photon Provisioning](docs/photon-provisioning.md).

Integrating with a coding agent? Point it at the [Coding Agent Quickstart](docs/coding-agent-quickstart.md) — provisioning, install, and handler wiring in one pass.

## Existing Handler

```ts
import { withConfigure } from "configure-spectrum";
import { adapterStore } from "./configure-spectrum-store";

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store: adapterStore,
  signIn: {
    linkMode: "managed",
    connectors: ["gmail", "calendar"],
  },
  connect: {
    mode: "intent",
    sendOnce: true,
    behavior: "send-and-stop",
    message: "Connect your Configure profile: {url}",
  },
});

for await (const [space, message] of app.messages) {
  await configureSpectrum.handle(space, message, async (ctx) => {
    let configureReadUsed = false;
    const tools = ctx.profile.tools({
      connectors: ["gmail", "calendar"],
      actions: ["email.send", "calendar.create_event"],
    });

    const reply = await runAgent({
      message,
      tools,
      executeTool: async (toolCall) => {
        const result = await ctx.profile.executeTool(toolCall);
        if (isReadBackedConfigureTool(toolCall.name)) configureReadUsed = true;
        return result;
      },
      linked: ctx.linked,
    });

    await message.reply(reply);
    if (configureReadUsed) {
      try {
        await ctx.profile.commit({
          messages: [
            { role: "user", content: ctx.text },
            { role: "assistant", content: reply },
          ],
        });
      } catch (error) {
        console.warn("[configure]", {
          event: "profile_commit_failed",
          errorKind: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  });
}

function isReadBackedConfigureTool(name: string): boolean {
  return name === "configure_profile_read" || name === "configure_profile_search";
}
```

`ctx.profile` is built from a linked Configure token when one is available, or from a developer-scoped external user before sign-in. That lets the rest of your agent use one profile runtime while Configure enforces the appropriate access boundary.

Use `ctx.profile.tools({ connectors, actions })` as the normal model-loop integration when your hosted Configure surface requested connector/action setup and your app supports those capabilities. Keep Configure tools available so the model can call `configure_profile_read` or `configure_profile_search` for overview, concrete memories, source-specific questions like "what does ChatGPT remember about me?", or details that need exact source attribution. Host-side `ctx.profile.read({ sections })` plus `profile.format()` is available for app-owned UI, inspection, or explicit context slots; it is not required for the normal model loop. After a read-backed turn, call `ctx.profile.commit()` with bounded user/assistant turn evidence.

Action tools, such as sending email or creating calendar events, change external state. Tool visibility means hosted/app capability, not user authorization. Expose actions when the product has requested and supports that capability; `ctx.profile.executeTool()` still fails closed when linked state, connector state, permissions, scopes, or approval state are missing. If a connector/action is unavailable, send the hosted connect, reconnect, permissions, or approval link.

When `connect` sends a hosted link, `handle()` returns before the handler runs. The model does not need to decide when to produce Configure sign-in URLs.

Hosted links use Configure's public `sign-in.me/{agent}` surface, so the model never needs to construct Configure URLs. If your app passes `signIn.agentPhone`, that explicit app-bound line is used first. Otherwise, for Spectrum iMessage dedicated-line spaces, the adapter reads Spectrum's routed line from `space.phone` and uses it when it is a valid E.164 phone number. Shared-mode sentinels such as `shared`, blank local-mode values, and other non-phone values are ignored, so Configure falls back to the normal hosted completion path instead of receiving an unreliable return phone.

In normal iMessage turns, you should not need a resolver: `space.phone` is the per-turn routed line and the adapter already uses it. `signIn.agentPhone` is for an explicit application binding or a carefully chosen fallback when your app can determine the line outside the current turn.

Photon Cloud's iMessage token endpoint, exposed by Spectrum as `cloud.issueImessageTokens(projectId, projectSecret)`, returns the active dedicated line pool plus short-lived provider tokens. It is useful for non-turn validation or single-line fallback, but it is not per-thread authority by itself. Discard tokens immediately, do not log the response, and only choose a line when there is exactly one active line or your app has a deterministic selection rule.

```ts
import { cloud } from "spectrum-ts";

const e164 = (value: unknown) =>
  typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value) ? value : undefined;

const configuredLine = async () => {
  const tokenData = await cloud.issueImessageTokens(projectId, projectSecret);
  if (tokenData.type !== "dedicated") return undefined;
  const lines = Object.values(tokenData.numbers)
    .map(e164)
    .filter((line): line is string => Boolean(line));
  return lines.length === 1 ? lines[0] : undefined;
};

const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent: "your-agent",
  store,
  signIn: {
    agentPhone: async (ctx) => e164(ctx.space.phone) ?? configuredLine(),
  },
});
```

Set `signIn.linkMode` to `"managed"` to route message sign-in through Configure's message URL API. When a return line is available, the adapter registers that line for the configured agent before requesting the URL. Configure returns the hosted fallback when signed sender proof is missing or unsupported, and reserves code-bearing links for verified message senders. The older `"auto"` value is still accepted as a compatibility alias for `"managed"`.

For production visibility, attach `onEvent` and send the redacted adapter events to your own telemetry sink:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  signIn: { linkMode: "managed" },
  onEvent(event) {
    console.info("[configure]", {
      event: event.event,
      channel: event.channel,
      identityState: event.identityState,
      actionState: event.actionState,
      outcome: event.outcome,
      reason: event.reason,
      properties: event.properties,
    });
  },
});
```

The hook is application-owned. The adapter does not send telemetry to Configure. Events include states, counts, modes, booleans, and reason codes; they intentionally omit raw phone numbers, tokens, URLs, message bodies, connector payloads, and profile facts.

`store` persists adapter state between messages: sender mappings, approved Configure tokens, sign-in delivery state, completion journeys, and webhook idempotency. It does not store Configure user memories or profile data. Most apps back this with the same persistence they already use for sessions, users, or webhook idempotency.

For local development and examples:

```ts
const store = withConfigure.localStore();
```

`withConfigure.localStore()` keeps adapter state in the current process. It resets when the worker restarts.

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
    linkMode: "managed",
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

`signIn.agentPhone` is the explicit app-bound return line. It can be a string or an async resolver. Prefer the current turn's `space.phone` when available. If you call Photon Cloud's token endpoint through `cloud.issueImessageTokens()`, treat it as an active line-pool lookup, not proof of a specific turn's routed line, and choose only a deterministic valid E.164 number. Values such as `shared` are ignored rather than sent to Configure.

In `linkMode: "managed"`, valid return lines are registered through Configure before the adapter asks for a message URL. If registration or message URL creation fails, the adapter omits return-phone metadata from its local fallback and keeps the hosted sign-in path usable.

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

Reconnect links use the same hosted surface as sign-in, but they only refresh the requested app connection. In `linkMode: "managed"`, the adapter asks Configure for a message URL and accepts the plain hosted reconnect URL unless verified Spectrum sender proof allows a code-bearing link.

## Webhook Composition

Compose this adapter inside Spectrum's webhook adapters. Spectrum should handle raw body parsing, signature verification, and provider normalization.

```ts
import express from "express";
import { Spectrum } from "spectrum-ts";
import { spectrum } from "@spectrum-ts/express";
import { withConfigure } from "configure-spectrum";

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
