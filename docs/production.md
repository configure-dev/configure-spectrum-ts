# Production Notes

Use a durable store for subject records, Configure tokens, sign-in journeys, and webhook idempotency.

## Store

Implement the `ConfigureSpectrumStore` interface against your database.

`saveSubject()` is an upsert/merge operation. A patch that updates `signInSentAt` must not erase an existing `configureToken`, and a patch that saves a token must preserve the subject's stable `externalId`.

## Webhooks

Use Spectrum's webhook adapters for raw body handling and signature verification. This adapter composes inside Spectrum's `onMessage` callback.

## Tokens

Keep Configure agent tokens server-side. The default stored-token validation policy is `on-first-use`: the adapter validates a stored token before its first linked use in the current process and caches the validation result in memory.

## Sensitive Data

Phone-like sender metadata is used only for recognition. Do not log raw phone candidates, Configure tokens, full message bodies, or webhook headers. If you customize `identity.phoneCandidates`, keep that extraction server-side.
