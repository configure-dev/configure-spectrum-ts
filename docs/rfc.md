# Configure + Spectrum RFC

`configure-spectrum` is a server-side adapter for applications already using Photon Spectrum (`spectrum-ts`).

The adapter resolves Configure identity and profile context at the Spectrum message boundary. Spectrum continues to own providers, streams, webhook normalization, replies, typing, and delivery. Configure owns hosted sign-in, user consent,  Profile permissions, connector state, profile reads, profile search, and tool execution.

The target product outcome is simple: a Spectrum message agent can personalize before the first generated reply when the sender is already approved, and can send a correct hosted sign-in or reconnect link when approval or connector access is missing.

## Goals

- Add Configure identity and Memory Profile access to existing Spectrum message handlers.
- Keep the developer's Spectrum app and model loop intact.
- Resolve sender state before the model runs.
- Make profile and connector tools available through `ctx.profile`.
- Use hosted Configure sign-in/reconnect links instead of model-generated URL construction.
- Support a bundled or dashboard-native Photon setup path if Photon wants Configure to feel native.
- Preserve strict boundaries between sender recognition, user approval, connector authorization, and tool execution.



## Non-Goals

- Replacing `spectrum-ts`.
- Re-exporting Photon/Spectrum provider APIs.
- Parsing or verifying Photon webhooks inside Configure.
- Owning the model loop.
- Hiding required production persistence behind process-local memory.
- Treating phone recognition as authorization.
- Granting Photon setup credentials direct access to end-user Memory Profiles.



## Public Adapter Shape

```ts
import { withConfigure } from "configure-spectrum";

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store,
  signIn: {
    linkMode: "managed",
    connectors: ["gmail", "calendar"],
  },
  connect: {
    mode: "intent",
    sendOnce: true,
    behavior: "send-and-stop",
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
      linked: ctx.linked,
      tools,
      executeTool: async (toolCall) => {
        const result = await ctx.profile.executeTool(toolCall);
        if (toolCall.name === "configure_profile_read" || toolCall.name === "configure_profile_search") {
          configureReadUsed = true;
        }
        return result;
      },
    });

    await message.reply(reply);

    if (configureReadUsed) ctx.profile.commit({
      messages: [
        { role: "user", content: ctx.text },
        { role: "assistant", content: reply },
      ],
    }).catch(() => {});
  });
}
```

The handler remains the developer's handler. The model remains the developer's model. Configure adds identity, profile, auth, and connector recovery context before the model turn begins.

## Runtime Contract

For each inbound Spectrum message, the adapter:

1. Optionally claims the message for idempotency through `store.claimMessage()`.
2. Derives a stable Configure subject key and thread key from Spectrum `space` and `message`.
3. Extracts phone-backed sender candidates when the channel exposes them.
4. Extracts `messageSenderProof` if Photon/Spectrum metadata exposes signed sender proof.
5. Loads any stored Configure token for this sender.
6. Validates stored tokens according to policy.
7. Attempts Configure phone recognition when phone-backed candidates exist.
8. Falls back to a developer-scoped external user when the sender is not linked.
9. Builds `ctx` with `linked`, `recognized`, `approved`, identity state, subject state, thread state, and `ctx.profile`.
10. If policy requires sign-in or reconnect, sends a hosted Configure link and stops before the model.
11. Otherwise runs the developer's handler.

Recognition is not authorization. `ctx.recognized` means Configure recognized sender evidence. `ctx.linked` means the sender has an approved Configure agent token for this app.

## Profile And Tool Pattern

The canonical Spectrum pattern is tool-driven:

- Expose `ctx.profile.tools()` to the model loop.
- Route Configure tool calls through `ctx.profile.executeTool`.
- Let the model call `configure_profile_read` for overview context.
- Let the model call `configure_profile_search` when a turn needs concrete memory, imported-source context, or attribution.
- Expose connector and action tools when the hosted Configure surface requested those capabilities and the product supports them.

Tool visibility is capability, not authorization. Tool execution still gates on linked state, connector state, scopes, permissions, approval state, and runtime policy.

Host-side reads are still useful for application-owned context slots:

```ts
const read = await ctx.profile.read({
  sections: ["identity", "preferences", "summary"],
});

const context = read.profile.format();
```

This should be used when the app deliberately wants to prefill a small orientation packet. It should not replace the default model-loop tool surface.

After read-backed turns, the app should call `ctx.profile.commit()` with bounded turn evidence. The write contract should stay permissive enough for production message agents: a missing commit should not block reads, but successful commits improve future personalization.

## Hosted Sign-In And Reconnect

Developers should not construct Configure hosted URLs in prompts or model output. The adapter owns the link path.

Set `signIn.linkMode` to `"managed"` to use Configure's message URL API:

```ts
const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
  signIn: {
    linkMode: "managed",
    connectors: ["gmail"],
  },
});
```

When a return line is available, the adapter registers that line for the configured agent before requesting a URL. Configure returns a plain hosted fallback when signed sender proof is missing or unsupported, and reserves code-bearing links for verified message senders.

Use sign-in when the sender has not approved this agent:

```ts
if (!ctx.linked && needsPersonalData(ctx)) {
  await ctx.replyWithSignIn();
  return;
}
```

Use reconnect when a linked sender asks for a connector-backed action and the connector is missing, expired, or lacks required permission:

```ts
await ctx.replyWithReconnect({
  connectors: ["gmail"],
  message: "Reconnect Gmail: {url}",
});
return;
```

`connect.behavior: "send-and-stop"` is the recommended message UX for required sign-in. The user receives the hosted link, completes Configure auth/connector setup, and returns to the correct application state.

## Message Return Line

The adapter should bind message return behavior to an application-owned line, not to arbitrary message payload metadata.

Priority:

1. Explicit `signIn.agentPhone`.
2. Async `signIn.agentPhone(ctx)` resolver that calls Photon for the current line.
3. Spectrum iMessage dedicated-line `space.phone` when it is a valid E.164 phone number.
4. Hosted Configure fallback when no reliable return line exists.

Shared-mode sentinels, local-mode placeholders, blank values, and non-phone strings must be ignored. They should not be registered with Configure as return lines.

## Photon Signed Sender Proof

Configure needs Photon signed sender proof to safely issue code-bearing message URLs.

The proof should allow Configure to verify:

- issuer
- audience
- subject/sender binding
- channel/provider
- message id or journey id
- project id
- return line, when applicable
- issued-at and expiration
- key id or verification endpoint reference

The adapter should continue to work before this exists. Without signed proof, it should fail closed to plain hosted links and produce a clear fallback reason such as `sender_proof_missing`, `sender_proof_invalid`, or `sender_proof_unsupported`.

Raw proofs must stay server-side. They should not be logged, sent to the model, or exposed to browser code.

## Bundled / Proxy Integration Model

A bundled Spectrum integration may be the best developer experience if Photon wants Configure to feel native rather than external.

In this model, Photon acts as the developer-facing proxy:

- The Photon developer enables Configure through Spectrum.
- Photon uses the developer's Photon project identity, such as `projectId`, plus a Photon server secret (`sk`) or equivalent server credential to call Configure on the developer's behalf.
- Configure receives a server-side request identifying Photon as the integration channel and the Photon project as the tenant/application boundary.
- Configure creates or resolves the corresponding Configure developer account, agent, API keys, and permission grants under a Photon-managed integration relationship.
- The Spectrum app receives the same `withConfigure()` runtime shape, but setup can be handled by Photon dashboard/API state instead of requiring the developer to manually create Configure resources first.

The integration should preserve Configure's data and permission model:

- Photon may act as the setup developer for Photon projects, but Configure still owns user consent, Memory Profile permissions, connected-tool state, hosted auth, and profile access enforcement.
- Each Photon project should map to a stable Configure developer/app boundary.
- Each Spectrum agent should map to a stable Configure agent identity.
- API keys and agent identity should be minted or scoped server-side.
- User-controlled message payloads must never determine Configure developer, agent, or storage paths.
- End-user profile access still requires Configure approval for the specific agent/application.
- Photon-held secrets and Configure-issued `sk_` keys must stay server-side.

Delegated Configure permissions should be explicit and narrow. Photon should be able to manage setup for Photon-owned projects, not act as a global Configure administrator.

Suggested delegated permissions:

- create or resolve a Configure developer account for a Photon project
- create or update a Configure agent for a Spectrum app
- mint, rotate, or revoke server-side Configure keys for that agent
- update Photon-sourced agent metadata
- register or revoke message return lines for managed sign-in/reconnect flows
- read integration-owned setup state and registration status

Out of scope for Photon setup credentials:

- reading end-user Memory Profiles
- writing end-user memories
- executing connector tools
- bypassing Configure user consent
- accessing another Photon project's Configure resources
- accessing non-Photon Configure developers or agents

Every delegated setup operation should be auditable by Photon project id, Configure developer id, Configure agent id, operation, timestamp, and credential used.

## Agent Metadata From Photon

Configure should derive initial agent metadata from Photon/Spectrum SDK or dashboard metadata when available.

Expected metadata:

- agent name
- stable slug or handle
- profile photo or app icon
- project id
- provider/channel information
- owner/developer identity
- dashboard/deep-link references, if safe

Suggested shape:

```ts
type PhotonConfigureAgentMetadata = {
  projectId: string;
  agentName: string;
  agentSlug: string;
  profilePhotoUrl?: string;
  channel?: string;
  dashboardUrl?: string;
};
```

Configure would use this metadata for the user-facing agent record, hosted sign-in display, consent screen, and message return copy. Photon should remain authoritative for Photon-native project/app metadata. Configure should remain authoritative for Configure approval state, user permissions, connector setup, and Memory Profile access.

Open metadata questions:

- What Spectrum SDK object or Photon API is authoritative for name, slug, and profile photo?
- Are slugs globally unique, project-scoped, or developer-scoped?
- Should Configure generate a slug when Photon does not supply one?
- How often should Configure sync Photon metadata updates?
- Can the profile photo URL be safely shown on hosted Configure auth screens?
- What should happen if Photon metadata changes after users have approved the agent?



## Store Contract

Production applications must persist adapter state with normal app infrastructure.

The store persists:

- subject records
- Configure tokens
- sign-in journey state
- idempotency claims
- completion journey references

The store does not persist Configure user memories or profile data.

`withConfigure.localStore()` is for development and tests only. It is process-local and resets on worker restart.

## Telemetry

The adapter exposes `onEvent(event)` for app-owned telemetry. It does not send telemetry to Configure by default.

Events should reveal the journey without private content:

- identity resolution start/result
- phone recognition attempts/failures
- stored-token validation
- duplicate message ignored
- sign-in required
- message URL requested/created/failed
- message-line registration attempted/completed
- sign-in link sent
- reconnect link sent

Event properties should use states, counts, booleans, modes, and reason codes. They must omit raw phone numbers, Configure tokens, URLs, message bodies, profile facts, connector payloads, and signed proofs.

## Security Boundaries

- Configure `sk_` keys stay server-side.
- Configure agent tokens stay server-side.
- Photon `sk` values stay server-side.
- Spectrum webhook verification stays in Spectrum/Photon.
- Configure does not parse or verify Photon webhooks directly.
- Phone recognition is identity evidence, not authorization.
- `ctx.linked` is the approved Configure token signal.
- Profile data is not exposed before approval.
- Developer-scoped unlinked state can exist, but it is not federated cross-agent identity.
- Auth/reconnect links are runtime outcomes, not model decisions.
- Return-line metadata must be bound to registered message lines before reflection.
- Code-bearing links require verified sender proof.



## Naming And Packaging

The current package line is `configure-spectrum`.

Options:


| Option                       | Strength                                             | Risk                                                                      |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `configure-spectrum`         | Fastest Configure-owned iteration; already reserved. | May feel external to Photon developers.                                   |
| `@configure-ai/spectrum-ts`  | Explicit Configure ownership; scoped package.        | Feels like a vendor adapter to Spectrum internals.                        |
| `@spectrum-ts/configure`     | Most native to Spectrum developers.                  | Implies Photon ownership, support, release, and dashboard responsibility. |
| Bundled Spectrum integration | Easiest discovery and install if done well.          | Requires clear ownership, versioning, support, and commercial agreement.  |


Bundling should be treated as a serious default path. The standalone package can remain the review and iteration vehicle while Photon decides whether to expose Configure as a native Spectrum capability.

## Pilot Plan

Test the adapter with three Photon developer customers before positioning it broadly. One candidate is SMRY: [https://smry.ai](https://smry.ai).

Pilot acceptance criteria:

- Developer can understand the install path from README/docs.
- Developer can add `withConfigure()` without rewriting the Spectrum app.
- Developer can implement the durable store contract.
- Known-user response can be personalized before the model turn.
- Unknown-user path sends hosted sign-in and does not run the model in the same turn.
- Reconnect path works without model-generated instructions.
- Configure tools execute through `ctx.profile.executeTool()`.
- Telemetry shows the journey without sensitive content.
- Missing Photon signed proof still produces a useful hosted fallback.



## What We Need From Photon

Technical:

- Confirm preferred package ownership and naming.
- Confirm whether bundled or dashboard-native installation is desirable.
- Confirm whether Photon should act as setup proxy for Configure registration.
- Confirm the Photon `projectId` and Photon server secret (`sk`) or equivalent credential shape Configure should trust for proxy registration.
- Define the permission model for Photon registering Configure developers and agents under the Photon integration.
- Define the authoritative SDK/API source for agent name, slug, and profile photo.
- Provide or document the authoritative agent return line source.
- Define the `messageSenderProof` availability path.
- Provide signed proof verification details and fixtures.
- Confirm stream/webhook parity.
- Confirm whether phone/contact claims can be included safely.
- Identify Spectrum object fields we should use or avoid for subject/thread keys.

Product:

- Identify three pilot developers.
- Decide dashboard placement for discovery.
- Decide docs ownership and where developers should start.
- Decide whether this should appear as a template, integration card, bundled package, or setup checklist step.
- Decide what "native enough" means for Spectrum developers.

Commercial:

- Decide whether revenue share is in scope.
- Decide support ownership.
- Decide whether pilot customers receive incentives or credits.



## Risks And Mitigations


| Risk                                                 | Mitigation                                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developers treat phone recognition as authorization. | Docs and types separate `recognized`, `approved`, and `linked`; only `ctx.linked` means approved token.                                            |
| Models generate auth/reconnect URLs.                 | Adapter sends links before handler/model and stops; docs keep URL construction out of prompts.                                                     |
| Return-phone metadata reflects arbitrary phones.     | Managed mode registers message lines before URL creation; backend enforces line binding.                                                           |
| Signed proof is delayed.                             | Plain hosted fallback works now; signed proof is additive.                                                                                         |
| Package feels external to Photon.                    | Align on package naming, docs placement, dashboard placement, and support ownership.                                                               |
| Bundled proxy setup blurs ownership boundaries.      | Use explicit Photon integration permissions, project-scoped developer registration, server-side key minting, and Configure-owned end-user consent. |
| Photon metadata and Configure agent records drift.   | Treat Photon as authoritative for name, slug, and profile photo, and define a sync/update policy.                                                  |
| Pilot debugging requires private content.            | Use redacted `onEvent` state machine and hashed identifiers.                                                                                       |
| Connector/action tools appear to authorize actions.  | Teach capability vs authorization: execution still gates on connection, scopes, approval, permissions, and runtime policy.                         |




## Roadmap



### Phase 1: Adapter Review

- Review public adapter shape.
- Confirm runtime context fields.
- Confirm tool-driven profile pattern.
- Confirm `spectrum-ts` remains a peer dependency.
- Confirm Configure remains a runtime dependency.



### Phase 2: Pilot Preparation

- Select three pilot developers.
- Prepare durable store examples.
- Prepare stream and webhook quickstarts.
- Prepare redacted telemetry template.
- Decide dashboard/docs entry point for pilot.



### Phase 3: Signed Proof Design

- Define `messageSenderProof` contract.
- Provide verification key discovery or endpoint.
- Provide fixtures.
- Confirm stream/webhook availability.
- Add Configure verifier behind fail-closed behavior.



### Phase 4: Native Distribution

- Decide package ownership/name.
- Decide whether Photon acts as setup proxy for bundled registration.
- Define metadata sync for name, slug, and profile photo.
- Define Configure permissions for Photon-created developers and agents.
- Decide dashboard placement.
- Decide docs ownership.
- Decide commercial/revenue-share structure.



## Decisions Requested

1. Should the public package remain `configure-spectrum`, move to a Photon-owned scope, or become bundled?
2. Where should developers discover Configure inside Photon?
3. Which three Photon developer customers should pilot it first?
4. Is SMRY an appropriate first pilot candidate?
5. What signed `messageSenderProof` shape can Photon provide?
6. Does Photon prefer JWKS, verification endpoint, or another proof-verification mechanism?
7. Should Configure appear as an identity/personalization add-on, a template, a bundled package, or a setup step?
8. Should revenue share be part of launch planning or deferred until after pilots?
9. Should Photon proxy Configure setup using Photon `projectId` and Photon server secret (`sk`) or equivalent server credentials?
10. What permissions should Configure grant Photon for registering developers and agents?
11. Which Photon SDK/API fields should Configure use for agent name, slug, and profile photo?



## Current V0.1 Decisions

- `connect.mode` defaults to `manual`.
- v0.1 includes the framework-neutral `configureSpectrum.complete()` helper.
- Default subject keys hash phone material.
- Stored token validation defaults to `on-first-use`.
- `spectrum-ts` is a peer dependency.
- `configure` is a runtime dependency.
