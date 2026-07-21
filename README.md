# Configure for Spectrum

`configure-spectrum` adds Configure identity, profiles, memory, and connected tools to an existing Photon Spectrum (`spectrum-ts`) message handler.

The adapter resolves the sender before application code runs and provides a permission-aware Configure profile runtime. Spectrum continues to own channels, providers, webhooks, messages, replies, typing, and delivery.

## Integration Paths

| Runtime owner | Integration |
| --- | --- |
| Photon | Native MCP integration (recommended) |
| Your application | This SDK adapter |

For Photon-hosted agents, Photon requests a short-lived session from Configure for each message and attaches the returned MCP server configuration to the model call. That lifecycle belongs in the Photon runtime and is not implemented by this package.

Use this package when your application owns the Spectrum message loop. It calls the Configure TypeScript SDK directly and exposes the result through the handler context. Its `profile.tools()` method returns model tool definitions; it does not create an MCP server.

## What the Adapter Does

- Resolves sender identity before the first model response.
- Provides one profile interface for linked and developer-scoped users.
- Preserves identity across channels when Spectrum provides a phone-backed sender identifier.
- Generates hosted Configure sign-in and reconnection links.
- Keeps Spectrum application structure, providers, and message delivery unchanged.

Recognition is not authorization. A recognized sender is linked only after the user approves the agent.

## Install

```bash
npm install configure-spectrum
```

Install Spectrum according to [Photon's documentation](https://photon.codes/docs/). `spectrum-ts` is a peer dependency. This package currently requires `configure@^1.1.16`.

## Provision Configure Credentials

A Spectrum application can provision Configure credentials from its existing Photon project credentials. No separate Configure signup is required.

> The provisioning endpoint is specified but not yet deployed. Until it is available, obtain `CONFIGURE_AGENT`, `CONFIGURE_API_KEY`, and `CONFIGURE_PUBLISHABLE_KEY` from the Configure dashboard.

```bash
curl -s -X POST https://api.configure.dev/v1/photon/installations \
  -u "$PHOTON_PROJECT_ID:$PHOTON_PROJECT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

Configure validates the credentials against Photon's `getProject` endpoint, then creates a Configure developer account, agent, secret key, and publishable key. The response includes an `env` object for the application environment.

The request is idempotent by Photon project. Configure returns a secret key only when it creates or rotates the key. See [Photon provisioning](docs/photon-provisioning.md) for the request contract, rotation behavior, and errors. For an automated implementation, use the [coding-agent quickstart](docs/coding-agent-quickstart.md).

## Basic Integration

The callback receives a `ConfigureSpectrumContext`, named `configureContext` below.

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
  await configureSpectrum.handle(space, message, async (configureContext) => {
    let usedConfigureRead = false;
    const tools = configureContext.profile.tools({
      connectors: ["gmail", "calendar"],
      actions: ["email.send", "calendar.create_event"],
    });

    const reply = await runAgent({
      message,
      tools,
      linked: configureContext.linked,
      executeTool: async (toolCall) => {
        const result = await configureContext.profile.executeTool(toolCall);
        if (isConfigureRead(toolCall.name)) usedConfigureRead = true;
        return result;
      },
    });

    await message.reply(reply);

    if (usedConfigureRead) {
      try {
        await configureContext.profile.commit({
          messages: [
            { role: "user", content: configureContext.text },
            { role: "assistant", content: reply },
          ],
        });
      } catch (error) {
        console.warn("[configure] profile commit failed", {
          errorKind: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  });
}

function isConfigureRead(name: string): boolean {
  return name === "configure_profile_read" || name === "configure_profile_search";
}
```

The profile runtime uses an approved Configure token when one is available. Before sign-in, it uses a stable user scoped to the developer account. Configure enforces the corresponding access boundary in both cases.

Use `profile.tools()` for model-controlled profile and connector access. Use `profile.read()` and `profile.format()` when the application owns a specific context slot or user interface. After a turn that reads Configure data, call `profile.commit()` with bounded user and assistant messages.

External actions, such as sending email or creating calendar events, can change user data. Expose only actions that the application supports. `profile.executeTool()` rejects requests when identity, connector state, permissions, scopes, or approval are insufficient.

## Message Context

`withConfigure().handle()` provides a `ConfigureSpectrumContext` with:

- `identity`: Configure's identity result for the sender.
- `profile`: profile reads, search, memory, model tools, and tool execution.
- `linked`: `true` only when the sender approved this agent.
- `recognized`: `true` when Configure recognized sender evidence; this does not grant access.
- `subject` and `thread`: stable keys for subject and thread state.
- `signInUrl()` and `replyWithSignIn()`: hosted sign-in helpers.
- `reconnectUrl()` and `replyWithReconnect()`: hosted connector-recovery helpers.

The context also includes the current `space`, `message`, normalized `text`, and platform metadata. See [`ConfigureSpectrumContext`](src/types.ts) for the complete type.

## Sign-In Policy

The adapter can send a hosted sign-in link before the model runs:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  signIn: { linkMode: "managed" },
  connect: {
    mode: "intent",
    intent: /\b(connect|link|sign[\s-]?in|login)\b/i,
    sendOnce: true,
    behavior: "send-and-stop",
    message: "Connect your Configure profile: {url}",
  },
});
```

`connect.mode` defaults to `"manual"`. Use `"intent"` to respond to sign-in requests or `"first-message"` to require sign-in before the first model response. When the adapter sends a link with `behavior: "send-and-stop"`, it does not run the application handler for that message.

Application code can also send a link directly:

```ts
if (!configureContext.linked && needsPersonalData(configureContext)) {
  await configureContext.replyWithSignIn();
  return;
}
```

For a connector that requires renewed access:

```ts
await configureContext.replyWithReconnect({
  connectors: ["gmail"],
  message: "Reconnect Gmail so I can continue: {url}",
});
return;
```

Do not construct Configure URLs in application code.

## Message Return

Hosted links use `https://sign-in.me/{agent}`. The adapter determines whether Configure can return the user to the same message channel after sign-in.

For an iMessage dedicated-line space, the adapter uses a valid E.164 number from `space.phone`. It ignores shared-mode sentinels, blank local values, and invalid phone values. Configure then uses its hosted completion page instead of attempting an unreliable message return.

Set `signIn.agentPhone` only when the application has an authoritative line binding. The current message's `space.phone` remains the preferred source. Photon Cloud's `cloud.issueImessageTokens()` can validate a dedicated line pool outside a message turn, but it does not identify the line for a specific thread. Select a value only when the result is deterministic, and never log returned tokens.

```ts
import { cloud } from "spectrum-ts";

const asE164 = (value: unknown) =>
  typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value)
    ? value
    : undefined;

const configuredLine = async () => {
  const tokenData = await cloud.issueImessageTokens(projectId, projectSecret);
  if (tokenData.type !== "dedicated") return undefined;

  const lines = Object.values(tokenData.numbers)
    .map(asE164)
    .filter((line): line is string => Boolean(line));

  return lines.length === 1 ? lines[0] : undefined;
};

const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  signIn: {
    linkMode: "managed",
    agentPhone: async (configureContext) =>
      asE164(configureContext.space.phone) ?? configuredLine(),
  },
});
```

With `linkMode: "managed"`, the adapter registers a valid return line before requesting the hosted message URL. Configure returns a code-bearing link only when verified sender proof is available. `"auto"` remains a compatibility alias for `"managed"`.

## Persistence

`store` persists adapter state between messages: sender mappings, approved Configure tokens, sign-in delivery, completion journeys, and webhook idempotency. It does not store user memories or profile data.

Use the in-memory store only for local development:

```ts
const store = withConfigure.localStore();
```

It resets when the process restarts. Production applications should implement persistent storage, including `claimMessage()` for webhook idempotency and journey methods when using `messageCompleteUrl`.

## Telemetry

Use `onEvent` to send redacted adapter events to the application's telemetry system:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
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

The adapter does not send these events to Configure. Events omit phone numbers, tokens, URLs, message bodies, connector payloads, and profile facts.

## Webhook Integration

Compose the adapter inside Spectrum's webhook adapter. Spectrum remains responsible for raw-body parsing, signature verification, and provider normalization.

```ts
import express from "express";
import { Spectrum } from "spectrum-ts";
import { spectrum } from "@spectrum-ts/express";
import { withConfigure } from "configure-spectrum";

const spectrumApp = await Spectrum({
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
    app: spectrumApp,
    onMessage: async (space, message) => {
      await configureSpectrum.handle(space, message, runAgent);
    },
  }),
);
```

## Production Requirements

- Keep `CONFIGURE_API_KEY` on the server.
- Use Spectrum's webhook verification and raw-body handling.
- Replace the local store with persistent application storage.
- Implement webhook idempotency with `claimMessage()`.
- Implement journey persistence before setting `messageCompleteUrl`.
- Define a stored-token validation policy.
- Use only authoritative E.164 return lines.
- Do not log credentials, tokens, phone numbers, message bodies, or webhook headers.
- Do not treat sender recognition as linked access.

See [Production guidance](docs/production.md) for implementation details.

## Package Boundaries

This package does not:

- Construct a Spectrum application.
- Re-export Spectrum providers, content builders, webhook adapters, or runtime APIs.
- Parse or verify Photon webhooks.
- Own the model loop, queue, retry worker, or outbound outbox.
- Implement Photon's native MCP session lifecycle.

## Stability

This package is pre-1.0. Breaking changes before `1.0` are documented in [`CHANGELOG.md`](CHANGELOG.md).
