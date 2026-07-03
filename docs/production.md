# Production Notes

Persist adapter state with the same storage layer your app already uses for server-side state.

## Store

Implement the `ConfigureSpectrumStore` interface with your app's normal persistence layer.

No special infrastructure is required. The store is a small server-side adapter for subject records, Configure tokens, sign-in journeys, and webhook idempotency.

`withConfigure.localStore()` is for local development and tests. It is process-local, so subject records, tokens, sign-in journeys, and idempotency claims are lost on restart.

This store only persists adapter state. It does not store Configure user memories or profile data; Configure stores those in the user's Memory Profile.

`saveSubject()` is an upsert/merge operation. A patch that updates `signInSentAt` must not erase an existing `configureToken`, and a patch that saves a token must preserve the subject's stable `externalId`.

## Webhooks

Use Spectrum's webhook adapters for raw body handling and signature verification. This adapter composes inside Spectrum's `onMessage` callback.

## Message Return

For Spectrum iMessage dedicated-line spaces, the adapter uses an explicit `signIn.agentPhone` first, then falls back to Spectrum's routed `space.phone` value when it is a valid E.164 phone number. That lets Configure return the user through the same message line without app code building hosted URL parameters.

If Photon exposes the current sending line through an API, pass `signIn.agentPhone` as a sync or async resolver. The adapter calls it when building sign-in and reconnect links, validates the result as E.164, and omits invalid values.

In `linkMode: "managed"`, the adapter registers valid return lines with Configure before requesting a message URL. If registration or message URL creation fails, it drops return-phone metadata from the local fallback and keeps the hosted sign-in fallback usable.

If the space is shared-mode (`shared`), local-mode, blank, or otherwise not a valid phone number, the adapter omits the return phone and leaves Configure on the hosted completion fallback. Do not store or pass shared-mode sentinels as phone numbers.

## Tokens

Keep Configure agent tokens server-side. The default stored-token validation policy is `on-first-use`: the adapter validates a stored token before its first linked use in the current process and caches the validation result in memory.

## Sensitive Data

Phone-like sender metadata is used only for recognition. Do not log raw phone candidates, Configure tokens, full message bodies, or webhook headers. If you customize `identity.phoneCandidates`, keep that extraction server-side.
