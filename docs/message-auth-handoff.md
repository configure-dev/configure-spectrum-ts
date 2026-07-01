# Configure Message Auth for Spectrum

Status: implementation baseline
Owner: Configure
Scope: `@configure-ai/spectrum-ts`, Configure quickstart message agent, Configure backend sign-in APIs, and the TypeScript SDK

## Summary

Configure sign-in, reconnect, and permission-review links should be delivered by the adapter before the developer's model handler runs. The model can receive identity/profile context after Configure state is resolved, but it should not decide when to send auth links or compose those links.

This is the implementation companion to the package-shape review spec. That spec defines the public adapter boundary for Spectrum developers. This document defines the backend, SDK, adapter, and quickstart work needed to make message-bound sign-in links real.

The current adapter already supports the plain message flow:

```txt
https://sign-in.me/{agent}
```

That path is the working fallback today, but it depends on phone-backed sender evidence after sign-in. To support cleaner Spectrum handoffs and channel-local subjects, Configure should own a message URL API that can return code-bearing links when Photon provides signed subject evidence.

The target code-bearing URL shape is:

```txt
https://sign-in.me/{agent}/{code}
```

The code is an opaque, short-lived Configure record. It is not a token, not a phone number, and not model-visible state. Configure should generate this code only when it receives and verifies a Photon-signed subject token for the current message subject. Without that signature, the adapter should use the plain `https://sign-in.me/{agent}` fallback and no code-bearing link should be created.

## Current State

As of this implementation baseline, the repos expose:

- `ctx.signInUrl()` in `@configure-ai/spectrum-ts`
- clean plain links for the no-completion message flow
- verbose SDK URLs when `messageCompleteUrl` or explicit URL overrides are present
- `configure.auth.signInUrl()`
- `configure.auth.createMessageSignInUrl()`
- `POST /v1/auth/sign-in/code`
- `POST /v1/auth/sign-in/exchange`
- `POST /v1/auth/sign-in/message-url`
- `POST /v1/auth/sign-in/recognize-phone`
- `POST /v1/auth/sign-in/validate`

The message URL endpoint currently implements the conservative preview behavior: it validates the request, audits the attempt, and returns `mode: "plain"` until Photon signature verification is configured. It must not create `sign-in.me/{agent}/{code}` links without verified Photon-signed subject evidence.

## Goals

- Keep Spectrum developers on their existing `Spectrum` app, message loop, providers, and webhook adapters.
- Resolve Configure identity before the model runs.
- Send hosted sign-in links outside the model hot path.
- Support the current plain `sign-in.me/{agent}` handoff as a fallback.
- Add a Configure-owned message URL API for message handoffs.
- Reserve reconnect and permission-review behavior for the same message URL surface.
- Require verified Photon-signed subject evidence for code-bearing message links.
- Continue to work without Photon-signed subject evidence by returning or building the plain sign-in fallback.
- Keep prompt/guidance injection as a nudge only, not as the auth enforcement mechanism.
- Make the quickstart demonstrate adapter-owned handoff.

## Non-Goals

- Do not replace `spectrum-ts`.
- Do not require developers to modify their system prompts for Configure sign-in.
- Do not require the model to call a tool to get the sign-in link.
- Do not expose Configure secret keys, agent tokens, raw phone candidates, or signed Photon claims to the model.
- Do not require new infrastructure from Spectrum developers just to use the adapter.
- Do not build a separate reconnect protocol if reconnect can be represented by the same hosted message URL surface.

## Target Developer Experience

Production-shaped usage:

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { withConfigure } from "@configure-ai/spectrum-ts";
import { adapterStore } from "./configure-spectrum-store";

const app = await Spectrum({
  projectId: process.env.PHOTON_PROJECT_ID!,
  projectSecret: process.env.PHOTON_PROJECT_SECRET!,
  providers: [imessage.config()],
});

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store: adapterStore,
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

Local quickstarts can keep:

```ts
const store = withConfigure.localStore();
```

Production apps should back the store with their normal server-side persistence. The store persists adapter state only: sender mappings, approved Configure tokens, sign-in delivery state, completion journeys, and webhook idempotency. It does not store Configure user memories or profile data.

After the message URL API lands, apps can opt into message-bound links without changing their handler:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  signIn: {
    linkMode: "auto",
  },
});
```

`auto` should prefer a code-bearing message URL only when the backend, SDK, and verified Photon-signed subject evidence are all available. Otherwise it should fall back to the current plain `sign-in.me/{agent}` flow.

## Control-Plane Flow

For each inbound Spectrum message:

1. Claim the message for idempotency when `store.claimMessage()` is available.
2. Derive the Configure subject key, thread key, external user id, channel, and phone candidates from Spectrum `space` and `message`.
3. Extract a Photon signed subject token when Spectrum/provider metadata exposes one.
4. Load any stored Configure token for the subject.
5. Validate the stored token according to the configured policy.
6. If no valid token exists, attempt Configure recognition from phone candidates and, later, signed subject token evidence.
7. Build a `ctx` object with linked, recognized, approved, profile runtime, and helper methods.
8. If `ctx.linked` is false and the configured connect policy says to send a link, create the hosted URL, send it, persist delivery state, and stop.
9. Otherwise call the developer's handler.

The model is not asked whether auth is needed. The adapter decides from structured state.

## State Model

```ts
type MessageAuthState =
  | {
      status: "approved";
      token: string;
      userId?: string;
      source: "stored_token" | "phone_recognition" | "signed_subject";
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

The current adapter represents most of this through `ctx.linked`, `ctx.recognized`, `ctx.approved`, `ctx.identity`, and `ctx.recognition`. Reconnect and signed-subject recognition are future work.

## Configure Message URL API

### Endpoint

Add a server-side endpoint:

```http
POST /v1/auth/sign-in/message-url
X-API-Key: sk_...
X-Agent: {agent}
Content-Type: application/json
```

This endpoint requires `requireAgent` and `requireSecretKey`. It should not accept publishable keys.

The endpoint should return a code-bearing URL only after verifying Photon-signed subject evidence. If no valid Photon signature is present, it should return a plain fallback URL and must not insert a message-link code record.

### Request

```ts
type CreateMessageSignInUrlRequest = {
  reason: "signin" | "reconnect" | "permissions";
  channel: "sms" | "imessage" | "whatsapp" | "slack" | "spectrum" | string;

  subject: {
    key: string;
    externalId: string;
    senderId?: string;
  };

  thread?: {
    key?: string;
    spaceId?: string;
    messageId?: string;
  };

  subjectToken?: string;
  connectors?: string[];
  displayName?: string;
  agentLogo?: string;
  theme?: "light" | "dark";
  returnMode?: "message";
  idempotencyKey?: string;
};
```

Notes:

- `subject.key` is the adapter's stable subject key, such as `sp_...`.
- `subject.externalId` is the developer-scoped fallback external id, such as `spectrum:sp_...`.
- `subjectToken` is the Photon-signed subject token when Spectrum exposes one. It is server-side only and must not be sent to the model.
- A code-bearing `mode: "minted"` response requires a present and verified `subjectToken`. If it is absent or invalid, the endpoint should return `mode: "plain"` with `fallbackReason` and no `code`.
- Do not put raw phone numbers in the code-bearing URL.
- Phone candidates, if needed for recognition, should remain part of recognition APIs rather than the message URL request.

### Response

```ts
type CreateMessageSignInUrlResponse =
  | {
      mode: "minted";
      url: string;
      code: string;
      reason: "signin" | "reconnect" | "permissions";
      expiresAt: string;
      idempotencyKey?: string;
    }
  | {
      mode: "plain";
      url: string;
      reason: "signin" | "reconnect" | "permissions";
      fallbackReason:
        | "subject_signature_missing"
        | "subject_signature_invalid"
        | "subject_signature_unsupported";
      idempotencyKey?: string;
    };
```

The code-bearing response URL should be:

```txt
https://sign-in.me/{agent}/{code}
```

The code is opaque and short-lived. It should be safe to display in a message thread but useless without Configure's hosted surface.

The plain response URL should be:

```txt
https://sign-in.me/{agent}
```

The plain response is not a magic link. It exists so callers can keep one message URL orchestration path while Configure refuses to create a message-bound code without verified Photon subject evidence.

### Backend Storage

Add a table for code-bearing message links. Suggested name:

```sql
create table message_sign_in_links (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  developer_account_id uuid not null references developer_accounts(id) on delete cascade,
  agent text not null,
  reason text not null check (reason in ('signin', 'reconnect', 'permissions')),
  channel text not null,
  subject_key text not null,
  external_id text not null,
  sender_id text,
  thread_key text,
  space_id text,
  message_id text,
  subject_token_hash text,
  connectors jsonb,
  display_name text,
  agent_logo text,
  theme text,
  return_mode text not null default 'message',
  idempotency_key text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  completed_at timestamptz
);

create unique index message_sign_in_links_idempotency_idx
  on message_sign_in_links(developer_account_id, agent, idempotency_key)
  where idempotency_key is not null;

create index message_sign_in_links_subject_idx
  on message_sign_in_links(developer_account_id, agent, subject_key, created_at desc);
```

Use a hash of the code at rest, following the existing sign-in return-code pattern. Do not insert a row for `mode: "plain"` fallback responses.

### Expiry And Idempotency

Recommended defaults:

- TTL: 10 minutes for code-bearing message links.
- Idempotency: if the same `(developer, agent, idempotencyKey)` has an unexpired code-bearing link with the same reason and subject, return the existing URL.
- If the previous code-bearing link is expired, create a replacement.
- Plain fallback responses do not create code rows. They may echo the idempotency key for caller correlation, but they should not consume the code-link idempotency namespace.
- Expired links should render a hosted "link expired" state with a safe instruction to message the agent again.

### Hosted Surface

The hosted `sign-in.me/{agent}/{code}` page should:

1. Look up the code through a public-safe lookup path or server-rendered loader.
2. Validate the code exists, belongs to the agent path, and has not expired.
3. Restore the existing Configure browser session when present.
4. If a valid Configure session exists, skip phone OTP.
5. If no session exists and no verified signed subject token can authenticate the user, fall back to the existing phone verification flow.
6. Show consent/profile review for the agent.
7. Apply connector setup when `connectors` is present.
8. Mint or confirm the agent-scoped token through the existing approval path.
9. Mark the message link completed.
10. Show a message-return success state.

The hosted page should not expose the agent token to browser-visible JS except through the existing, intended hosted flow boundaries. It should never expose a Configure secret key.

### Signed Subject Tokens

Code-bearing message links require Photon signed subject tokens. The endpoint can ship before Photon signatures are available, but in that state it should return `mode: "plain"` and must not generate a magic-code URL.

When available, Configure should verify the subject token server-side and treat it as channel identity evidence. The token should be checked for:

- issuer
- audience
- expiration
- channel/project identity
- subject id
- phone or verified contact claim when present
- signature against Photon-provided keys

If the signed subject token identifies a federated Configure user that already approved the agent, the hosted page can skip OTP and go directly to consent/success as appropriate.

If the signed subject token only identifies a channel-local subject, it can bind the code-bearing link to the message subject and help future recognition, but it must not grant cross-agent profile access by itself.

## TypeScript SDK

Add an SDK method on `auth`:

```ts
const result = await configure.auth.createMessageSignInUrl({
  reason: "signin",
  channel: "imessage",
  subject: {
    key: ctx.subject.key,
    externalId: ctx.subject.externalId,
    senderId: ctx.subject.senderId,
  },
  thread: {
    key: ctx.thread.key,
    spaceId: ctx.thread.spaceId,
    messageId: ctx.message.id,
  },
  subjectToken,
  idempotencyKey,
});
```

Suggested types:

```ts
export type MessageSignInReason = "signin" | "reconnect" | "permissions";

export interface CreateMessageSignInUrlOptions {
  reason: MessageSignInReason;
  channel: string;
  subject: {
    key: string;
    externalId: string;
    senderId?: string;
  };
  thread?: {
    key?: string;
    spaceId?: string;
    messageId?: string;
  };
  subjectToken?: string;
  connectors?: string[];
  displayName?: string;
  agentLogo?: string;
  theme?: "light" | "dark";
  returnMode?: "message";
  idempotencyKey?: string;
}

export interface CreateMessageSignInUrlResult {
  mode: "minted" | "plain";
  url: string;
  code?: string;
  reason: MessageSignInReason;
  expiresAt?: string;
  fallbackReason?:
    | "subject_signature_missing"
    | "subject_signature_invalid"
    | "subject_signature_unsupported";
  idempotencyKey?: string;
}
```

This method is server-side only because it uses the secret key.

## Spectrum Adapter Changes

Add a single internal URL provider so plain, completion, and message-bound flows share one path:

```ts
type ConfigureSpectrumUrlProvider = (input: ConfigureSpectrumUrlRequest) =>
  Promise<ConfigureSpectrumUrlResult>;

type ConfigureSpectrumUrlRequest = {
  reason: "signin" | "reconnect" | "permissions";
  ctx: ConfigureSpectrumContext;
  connectorIds?: string[];
};

type ConfigureSpectrumUrlResult = {
  mode: "minted" | "plain";
  url: string;
  expiresAt?: string;
  idempotencyKey?: string;
  fallbackReason?:
    | "subject_signature_missing"
    | "subject_signature_invalid"
    | "subject_signature_unsupported";
};
```

Public adapter options:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  signIn: {
    linkMode: "auto", // "plain" | "minted" | "auto"
  },
});
```

Recommended behavior:

- `plain`: current `https://sign-in.me/{agent}` behavior.
- `auto`: call `configure.auth.createMessageSignInUrl()` only when the SDK/backend supports it and a Photon-signed subject token is available; use `mode: "minted"` responses when verification succeeds and plain fallback otherwise.
- `minted`: private-preview/debug mode that requests the message URL API when a subject token is available. It must still accept `mode: "plain"` fallback responses and must never force a code-bearing URL without verified Photon-signed subject evidence.

The adapter should still support a custom provider for private preview testing:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  signIn: {
    mintUrl: async (request) => {
      return { mode: "minted", url, expiresAt, idempotencyKey };
    },
  },
});
```

`ctx.signInUrl()` remains the public helper. The developer handler does not change.

## Adapter Store Changes

Code-bearing message URLs that include `expiresAt` must not be blocked forever by a previous `signInSentAt`. Add fields:

```ts
interface ConfigureSpectrumSubject {
  signInSentAt?: string;
  signInExpiresAt?: string;
  signInIdempotencyKey?: string;
}

interface ConfigureSpectrumSubjectContext {
  signInSentAt?: string;
  signInExpiresAt?: string;
}
```

`sendOnce` should mean:

> Send at most one still-valid link for this subject and reason.

For plain links, `signInExpiresAt` can remain absent and current behavior is preserved. For code-bearing links, `shouldConnect()` should allow another link when `signInExpiresAt` is in the past.

## Reconnect

Reconnect should use the same message URL path:

```ts
await configure.auth.createMessageSignInUrl({
  reason: "reconnect",
  channel,
  subject,
  subjectToken,
  connectors: ["gmail"],
  idempotencyKey,
});
```

If `subjectToken` is absent or cannot be verified, the response should be `mode: "plain"` and the hosted surface should fall back to normal sign-in/reconnect handling without a magic code.

Reconnect signals:

- `tool_not_connected`
- `provider_account_missing`
- `provider_scope_missing`
- `insufficient_permissions`
- connector state with `reconnectRequired: true`

When reconnect is detected, the adapter should send a hosted reconnect link and stop the turn if policy is `auto`.

Reconnect can initially fall back to normal sign-in copy if hosted reconnect-specific UI is not ready. The API should still reserve `reason: "reconnect"` and `connectors` now.

## Recognition And URL Creation

Recognition/state and message URL creation should remain separate backend primitives.

Recognition answers:

> What is true about this sender?

URL creation answers:

> Create a user-facing hosted URL for this sender and action.

Keeping them separate improves auditability, rate limiting, and prevents accidental link creation during ordinary recognition checks.

The adapter can orchestrate both internally, but backend endpoints should remain separate.

## Why This Is Not A Tool Call

A sign-in link is auth control plane, like redirecting to SSO before serving a web route.

It should not be a model tool because:

- it puts auth into the model hot path
- it requires prompt instructions
- it is less deterministic
- it can produce awkward or incorrect UX
- it weakens auditability and idempotency
- it mixes identity and consent concerns with agent personality

Configure tools remain useful after auth for profile and connector operations. Initial sign-in and reconnect handoffs should be adapter/runtime behavior.

## Quickstart Cleanup

The quickstart should continue to:

- use adapter-owned `connect` behavior
- avoid putting `ctx.signInUrl()` in model/system prompt text
- use `ctx.linked || profileHasData(profile)` before including profile context
- document that the current plain link flow depends on phone-backed sender evidence
- switch to the message URL API once the backend/SDK method exists, while keeping code-bearing links gated on verified Photon signatures

The model prompt should describe only the agent's behavior and available context:

```ts
const { profile } = await ctx.profile.read();
const system = ctx.linked || profileHasData(profile)
  ? `${STYLE}\n\nWhat Configure already remembers about this user:\n${JSON.stringify(profile, null, 2)}`
  : `${STYLE}\n\nNo approved Configure profile is available for this sender yet. Do not claim personal context you do not have.`;
```

## Security Requirements

- Keep `sk_` keys server-side.
- Keep Configure agent tokens server-side.
- Do not pass signed Photon claims to the model.
- Do not log raw phone candidates, tokens, full webhook headers, full message bodies, or message URL codes.
- Treat recognition as identity evidence, not authorization.
- Treat `ctx.linked` as the approved-token signal.
- Use idempotency keys for webhook retries and message URL creation.
- Keep code-bearing link creation audited and rate-limited.
- Store only code hashes, not raw codes.
- Do not reveal federated or cross-agent profile contents before approval. Developer-scoped unlinked context can still be used under Configure's normal unlinked-user boundary.

## Implementation Phases

### Phase 1: Current Adapter And Quickstart

- Use clean `sign-in.me/{agent}` links for the plain flow.
- Configure quickstart with adapter-owned `connect` behavior.
- Remove sign-in URL injection from the model prompt.
- Keep `connect.mode` defaulting to `manual` in the package.

Status: complete for the current plain-link path.

### Phase 2: Configure Message URL API

Backend:

- Add `message_sign_in_links` migration. **Baseline complete.**
- Add `POST /v1/auth/sign-in/message-url`. **Baseline complete.**
- Validate request shape, require `sk_`, audit attempts, and return `mode: "plain"` while signature verification is unavailable. **Baseline complete.**
- Add code hashing, expiry, idempotency, audit events, and rate limits for `mode: "minted"` responses. **Remaining for signed-subject phase.**
- Add a Photon signature verification boundary. Until Photon key discovery and claim format are configured, the endpoint should always return `mode: "plain"`.
- Require a verified Photon signature before generating `sign-in.me/{agent}/{code}`.
- Return `mode: "plain"` and create no code record when the Photon signature is missing, invalid, or unsupported.
- Add hosted lookup/completion handling for `sign-in.me/{agent}/{code}`.
- Preserve existing hosted OTP/approval fallback.

TypeScript SDK:

- Add `auth.createMessageSignInUrl()`. **Baseline complete.**
- Export request/response types. **Baseline complete.**
- Document server-side secret-key requirement. **Baseline complete.**

Spectrum adapter:

- Add internal URL provider. **Baseline complete.**
- Add `signIn.linkMode`. **Baseline complete.**
- Add optional `signIn.mintUrl` provider for private preview. **Baseline complete.**
- Route `ctx.signInUrl()` through the provider. **Baseline complete.**
- Ensure `ctx.signInUrl()` never emits a code-bearing magic link without verified Photon-signed subject evidence. **Baseline complete.**
- Add `signInExpiresAt` and `signInIdempotencyKey` store fields. **Baseline complete.**
- Make `sendOnce` expiry-aware. **Baseline complete.**

Quickstart:

- Keep plain flow by default until backend is deployed.
- Add a note or option showing `linkMode: "auto"` after the API is available. **Baseline complete in adapter docs; quickstart update depends on refreshed tarball.**
- Refresh vendored tarball after adapter changes.

### Phase 3: Signed Subject Extraction And Recognition

- Confirm Photon signed subject token location in Spectrum objects.
- Add adapter extraction with safe defaults.
- Add recognition path from signed subject token.
- Allow OTP bypass only when token verification and existing Configure session/user binding are sound.

### Phase 4: Reconnect

- Add typed reconnect detection around Configure connector/tool failures.
- Create reconnect URLs with `reason: "reconnect"` and connector metadata.
- Send reconnect links through Spectrum and stop the turn under auto policy.

### Phase 5: Guidance

- Implement SDK guidance as tool descriptions/results or hoistable strings.
- Keep guidance transparent and toggleable.
- Do not rely on guidance for sign-in or reconnect enforcement.

## Tests

Backend tests:

- `POST /v1/auth/sign-in/message-url` requires `sk_`.
- `pk_` cannot call the message URL endpoint.
- Missing subject key/external id fails validation.
- Missing Photon signature returns a plain fallback response and creates no message-link row.
- Invalid Photon signature returns `mode: "plain"` with `fallbackReason: "subject_signature_invalid"` and creates no message-link row.
- Valid Photon signature is required for a code-bearing `mode: "minted"` response.
- Idempotency returns the same unexpired code-bearing link.
- Expired idempotent code-bearing link is replaced.
- Plain fallback responses do not create code rows or block a later signed request with the same idempotency key.
- Code hash is stored; raw code is not.
- Hosted lookup rejects expired/unknown codes.
- Hosted lookup rejects agent/code mismatch.
- Reconnect request preserves reason/connectors.

SDK tests:

- `createMessageSignInUrl()` posts the expected body.
- It maps minted and plain fallback responses.
- It rejects malformed responses.

Adapter tests:

- plain flow still returns `https://sign-in.me/{agent}` without query params
- `sendOnce` suppresses a second plain link
- message URL provider is called only when policy and subject evidence allow it
- `mode: "minted"` result stores `signInExpiresAt`
- plain fallback result does not store `signInExpiresAt` as a magic-link expiry
- expired `signInExpiresAt` permits a replacement link
- unexpired `signInExpiresAt` suppresses duplicate links
- developer handler does not run when the adapter sends a link

Quickstart tests:

- Typecheck against the refreshed adapter tarball.
- Manual E2E with real Spectrum/iMessage line after backend deployment.

## Acceptance Criteria

- Existing Spectrum apps can add Configure with one adapter.
- The quickstart demonstrates adapter-owned sign-in delivery.
- The model is not given a sign-in URL in its system prompt.
- Plain message sign-in works without Photon signed-token support.
- Magic-code links are never generated without verified Photon-signed subject evidence.
- Code-bearing message URLs can be introduced without changing the developer's handler.
- Reconnect has a reserved message URL shape.
- Guidance injection is documented as a nudge, not the auth mechanism.
- Code-bearing URL creation is auditable, rate-limited, idempotent, and short-lived.

## Handoff Checklist

Before implementation starts, confirm:

- Final endpoint path: recommended `POST /v1/auth/sign-in/message-url`.
- Final hosted route: recommended `https://sign-in.me/{agent}/{code}`.
- Message link TTL.
- Rate-limit bucket and audit event names.
- Whether initial reconnect falls back to normal sign-in UI or gets dedicated hosted copy.
- Final Photon signature contract: issuer, audience, key discovery, claim names, and accepted channels.
- Where Spectrum exposes signed subject tokens once Photon ships them.
- Whether quickstart should stay on the vendored tarball until preview publish, or consume a local packed tarball from the adapter repo.

The next implementation should not change the developer handler API unless the backend requires input that cannot be derived from Spectrum state.
