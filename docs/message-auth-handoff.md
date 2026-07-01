# Message Auth Handoff Spec

Status: draft
Owner: Configure
Scope: `@configure-ai/spectrum-ts`, Configure quickstart message agent, and the upcoming Configure URL minting API

## Summary

Configure sign-in and reconnect links should be delivered by the adapter before the developer's model handler runs. The model can receive identity/profile context after Configure state is resolved, but it should not be responsible for deciding when to send a sign-in link or for composing that link.

The current adapter can already send a clean hosted link for the plain message flow:

```txt
https://sign-in.me/{agent}
```

That path does not require the upcoming Photon signed-token or magic-link flow. The hosted page can still run the existing Configure verification and consent flow, and the agent can recognize the user by phone on the next message when Spectrum exposes phone-backed sender evidence.

Jon's URL minting API will later provide stronger signed-token and magic-code handoffs. The adapter should be structured so that API can replace or augment `ctx.signInUrl()` without changing the developer's model loop.

## Goals

- Keep Spectrum developers on their existing `Spectrum` app, message loop, providers, and webhook adapters.
- Resolve Configure identity before the model runs.
- Send hosted sign-in links outside the model hot path.
- Support the current plain `sign-in.me/{agent}` handoff.
- Add a clear extension point for Jon's URL minting API.
- Reserve reconnect behavior for the same URL minting surface.
- Keep prompt/guidance injection as a nudge only, not as the enforcement mechanism.
- Make the quickstart demonstrate the intended adapter-owned handoff.

## Non-Goals

- Do not replace `spectrum-ts`.
- Do not require developers to modify their system prompts for Configure sign-in.
- Do not require the model to call a tool to get the sign-in link.
- Do not expose Configure secret keys, agent tokens, raw phone candidates, or signed Photon claims to the model.
- Do not build a separate reconnect protocol if reconnect can be represented by the same hosted URL minting surface.

## Current State

`ctx.signInUrl()` now returns a clean URL for the plain message flow when no completion journey or explicit URL overrides are present:

```txt
https://sign-in.me/{agent}
```

The verbose URL form is still used when `messageCompleteUrl` is configured or when the caller passes explicit overrides. That preserves the existing webhook-completion path.

`configureSpectrum.handle()` already supports adapter-owned link delivery through `connect` options:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  connect: {
    mode: "intent",
    sendOnce: true,
    behavior: "send-and-stop",
    message: "Connect your Configure profile: {url}",
  },
});
```

The Configure quickstart should use this path and remove sign-in URLs from model/system prompt text.

## Target Developer Experience

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { withConfigure } from "@configure-ai/spectrum-ts";

const app = await Spectrum({
  projectId: process.env.PHOTON_PROJECT_ID!,
  projectSecret: process.env.PHOTON_PROJECT_SECRET!,
  providers: [imessage.config()],
});

const store = withConfigure.localStore(); // Local quickstart only.

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store,
  signIn: {
    displayName: "Configure",
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
    const { profile } = await ctx.profile.read();
    await runAgent({ space, message, profile, linked: ctx.linked });
  });
}
```

The handler only runs when the adapter has not already handled the turn by sending a sign-in link.

In production, replace `withConfigure.localStore()` with an implementation backed by the app's normal persistence layer. `sendOnce: true` is safe for the current plain `sign-in.me/{agent}` flow because that URL is not per-user or short-lived. Once the adapter uses minted URLs with `expiresAt`, resend suppression must become expiry-aware.

## Control-Plane Flow

For each inbound Spectrum message:

1. Claim the message for idempotency when `store.claimMessage()` is available.
2. Derive the Configure subject key, thread key, external user id, and phone candidates.
3. Load any stored Configure token for the subject.
4. Validate the stored token according to the configured policy.
5. If no valid token exists, attempt Configure phone recognition when phone candidates are available.
6. Build a `ctx` object with linked, recognized, approved, profile runtime, and helper methods.
7. If `ctx.linked` is false and the configured connect policy says to send a link, send the hosted sign-in message and stop.
8. Otherwise call the developer's handler.

The model is not asked whether auth is needed. The adapter decides from structured state.

## State Model

```ts
type MessageAuthState =
  | {
      status: "approved";
      token: string;
      userId?: string;
      source: "stored_token" | "phone_recognition" | "photon";
    }
  | {
      status: "recognized_unapproved";
      displayName?: string | null;
    }
  | {
      status: "unlinked";
    }
  | {
      status: "token_invalid";
    }
  | {
      status: "reconnect_required";
      connectors: ConnectorIssue[];
    };

type ConnectorIssue = {
  id: "gmail" | "calendar" | "drive" | "notion" | "sheets";
  reason?:
    | "provider_account_missing"
    | "provider_scope_missing"
    | "insufficient_permissions"
    | string;
};
```

The current adapter represents most of this through `ctx.linked`, `ctx.recognized`, `ctx.approved`, `ctx.identity`, and `ctx.recognition`. Reconnect is future work.

## Link Generation

### Current Plain Flow

When no completion journey is configured, the default link is:

```txt
https://sign-in.me/{agent}
```

This is appropriate for a text/message thread because:

- the hosted Configure OTP flow is public
- publishable-key query params are not required for the plain flow
- the agent can re-recognize the sender after the user completes sign-in
- the URL is readable and professional in a message

### Existing Completion Flow

When `messageCompleteUrl` is configured, the adapter preserves the verbose URL path with journey metadata. That flow is for apps that want the hosted page to call back into the agent service and save the returned token without relying on a later inbound user message.

### Future Minted Flow

When Jon's URL minting API is available, the adapter should call it from the same control-plane slot currently occupied by `ctx.signInUrl()`.

Expected request shape:

```ts
type MintMessageUrlRequest = {
  reason: "signin" | "reconnect" | "permissions";
  agent: string;
  channel: "sms" | "imessage" | "whatsapp" | "slack" | "spectrum" | string;
  subjectId?: string;
  subjectToken?: string;
  spaceId?: string;
  messageId?: string;
  connectors?: string[];
  returnMode?: "message";
  idempotencyKey?: string;
};
```

Expected response shape:

```ts
type MintMessageUrlResponse = {
  url: string;
  expiresAt?: string;
  reason: "signin" | "reconnect" | "permissions";
  idempotencyKey?: string;
};
```

The adapter API should not force developers to care whether the returned URL is plain, minted, signed, or reconnect-specific.

Minted URLs that include `expiresAt` must not be blocked forever by a previous `signInSentAt`. The adapter should store the minted URL expiration or a resend-after timestamp and allow a fresh link once the previous link has expired. `sendOnce` should mean "send at most one still-valid link for this subject," not "never send another link."

## Reconnect

Reconnect should use the same hosted URL minting path when it is available.

The adapter/runtime should treat these as reconnect signals:

- `tool_not_connected`
- `provider_account_missing`
- `provider_scope_missing`
- `insufficient_permissions`
- connector state with `reconnectRequired: true`

When reconnect is detected, the adapter should send a hosted reconnect link and stop the turn if policy is `auto`.

Example user-facing message:

```txt
Reconnect Gmail to continue: {url}
```

Reconnect may initially be unsupported by the minting API. The request shape should still reserve `reason: "reconnect"` and `connectors` so the adapter does not need a breaking change later.

## Relation To SDK Guidance Injection

The GitHub issue for guidance injection is about improving model behavior by shipping Configure guidance through SDK-owned text slots:

- tool descriptions
- tool results
- optional hoistable guidance strings

That work is useful, but it should not be responsible for sign-in or reconnect correctness.

Guidance injection is lower authority than the system prompt and should be treated as a nudge. Auth and reconnect link delivery are deterministic control-plane actions and should be enforced by the adapter before or around model execution.

Recommended separation:

- **Adapter control plane:** validates/recognizes identity, sends sign-in/reconnect links, stores tokens, handles idempotency.
- **Model guidance:** explains how to use Configure profile/tool results responsibly after the adapter has allowed the model to run.

## Quickstart Cleanup

The quickstart should stop putting `ctx.signInUrl()` into model/system prompt text.

Current anti-pattern:

```ts
const system = profileHasData(profile)
  ? `${STYLE}\n\nWhat Configure already remembers about this user:\n${JSON.stringify(profile, null, 2)}`
  : `${STYLE}\n\nYou don't have a profile for them yet. When they ask who they are or how this works, ` +
    `invite them to load it by tapping this link (send it as its own message):\n${await ctx.signInUrl()}`;
```

Preferred pattern:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  signIn: {
    displayName: "Configure",
    agentPhone: process.env.AGENT_PHONE_NUMBER,
  },
  connect: {
    mode: "intent",
    sendOnce: true,
    behavior: "send-and-stop",
    message: "Connect your Configure profile: {url}",
  },
});
```

Then the model prompt can describe only the agent's behavior and available context:

```ts
const { profile } = await ctx.profile.read();
const system = ctx.linked || profileHasData(profile)
  ? `${STYLE}\n\nWhat Configure already remembers about this user:\n${JSON.stringify(profile, null, 2)}`
  : `${STYLE}\n\nNo approved Configure profile is available for this sender yet. Do not claim personal context you do not have.`;
```

If the product wants a sign-in link on first contact rather than only on connect intent, use:

```ts
connect: {
  mode: "first-message",
  sendOnce: true,
  behavior: "send-and-stop",
}
```

That is a product choice, not a model instruction.

## Security Requirements

- Keep `sk_` keys server-side.
- Keep Configure agent tokens server-side.
- Do not pass signed Photon claims to the model.
- Do not log raw phone candidates, tokens, full webhook headers, or full message bodies.
- Treat recognition as identity evidence, not authorization.
- Treat `ctx.linked` as the approved-token signal.
- Use idempotency keys for webhook retries and URL minting.
- Keep link minting audited and rate-limited.
- Do not reveal federated or cross-agent profile contents before approval. Developer-scoped unlinked context can still be used under Configure's normal unlinked-user boundary.

## Implementation Phases

### Phase 1: Current Adapter And Quickstart

- Use clean `sign-in.me/{agent}` links for the plain flow.
- Configure quickstart with adapter-owned `connect` behavior.
- Remove sign-in URL injection from the model prompt.
- Keep `connect.mode` defaulting to `manual` in the package.

Status: complete for the current plain-link path.

### Phase 2: URL Minting API Integration

- Add an internal adapter URL provider that can call Jon's minting API.
- Preserve `ctx.signInUrl()` as the public helper.
- Route plain, completion, and minted flows through one internal abstraction.
- Add idempotency support when minting links.
- Track minted URL expiration so `sendOnce` does not suppress replacement links after expiry.

Recommended implementation shape:

```ts
type ConfigureSpectrumUrlProvider = (input: ConfigureSpectrumUrlRequest) =>
  Promise<ConfigureSpectrumUrlResult>;

type ConfigureSpectrumUrlRequest = {
  reason: "signin" | "reconnect" | "permissions";
  ctx: ConfigureSpectrumContext;
  connectorIds?: string[];
};

type ConfigureSpectrumUrlResult = {
  url: string;
  expiresAt?: string;
  idempotencyKey?: string;
};
```

The default provider should keep today's behavior:

- return `https://sign-in.me/{agent}` for the plain flow
- use the existing verbose Configure SDK URL when `messageCompleteUrl` or explicit overrides are present

The minted provider can be added as an option later without changing the developer handler:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  signIn: {
    mintUrl: async (request) => {
      // Calls Jon's API.
      return { url, expiresAt, idempotencyKey };
    },
  },
});
```

Store changes for minted URLs:

```ts
interface ConfigureSpectrumSubject {
  signInSentAt?: string;
  signInExpiresAt?: string;
  signInIdempotencyKey?: string;
}
```

`shouldConnect()` should allow another link when `signInExpiresAt` is in the past. For plain links, `signInExpiresAt` can remain absent and `sendOnce` behaves as it does today.

Test cases to add:

- plain flow still returns `https://sign-in.me/{agent}` without query params
- `sendOnce` suppresses a second plain link
- minted provider is called for the configured signed/minted path
- minted result stores `signInExpiresAt`
- expired `signInExpiresAt` permits a replacement link
- unexpired `signInExpiresAt` suppresses duplicate links

### Phase 3: Reconnect

- Add typed reconnect detection around Configure connector/tool failures.
- Mint reconnect URLs with `reason: "reconnect"` and connector metadata.
- Send reconnect links through Spectrum and stop the turn under auto policy.

### Phase 4: Guidance

- Implement SDK guidance as tool descriptions/results or hoistable strings.
- Keep guidance transparent and toggleable.
- Do not rely on guidance for sign-in or reconnect enforcement.

## Acceptance Criteria

- Existing Spectrum apps can add Configure with one adapter.
- The quickstart demonstrates adapter-owned sign-in delivery.
- The model is not given a sign-in URL in its system prompt.
- Plain message sign-in works without Photon signed-token support.
- Future minted URLs can be introduced without changing the developer's handler.
- Reconnect has a reserved URL minting shape.
- Guidance injection is documented as a nudge, not the auth mechanism.

## Handoff Checklist

Before implementation starts, confirm:

- Jon's minting endpoint path, auth headers, request fields, and response fields.
- Whether Photon signed subject tokens arrive on the Spectrum `message`, `space`, or provider metadata.
- Whether minted URLs are single-use, multi-use until expiry, or idempotent by `idempotencyKey`.
- Whether reconnect is initially unsupported, normal-sign-in fallback, or a separate hosted mode.
- Whether quickstart should stay on the vendored tarball until preview publish, or consume a local packed tarball from the adapter repo.

The next implementation should not change the developer handler API unless Jon's API forces a new input that cannot be derived from Spectrum state.
