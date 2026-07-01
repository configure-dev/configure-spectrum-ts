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

## Tokens

Keep Configure agent tokens server-side. The default stored-token validation policy is `on-first-use`: the adapter validates a stored token before its first linked use in the current process and caches the validation result in memory.

## Sensitive Data

Phone-like sender metadata is used only for recognition. Do not log raw phone candidates, Configure tokens, full message bodies, or webhook headers. If you customize `identity.phoneCandidates`, keep that extraction server-side.
