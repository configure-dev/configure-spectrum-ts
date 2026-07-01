# Configure SSO for Spectrum message handlers

`@configure-ai/spectrum-ts` adds Configure sign-in and profile access to an existing Spectrum message handler. It composes with Spectrum's message stream and webhook adapters, then gives each handler a Configure identity result and profile runtime for the current sender.

```bash
npm install @configure-ai/spectrum-ts
```

```ts
import { withConfigure } from "@configure-ai/spectrum-ts";

const configureSpectrum = withConfigure({
  apiKey: process.env.CONFIGURE_API_KEY!,
  publishableKey: process.env.CONFIGURE_PUBLISHABLE_KEY!,
  agent: process.env.CONFIGURE_AGENT!,
  store,
});

// Use your existing Spectrum app and message loop.
for await (const [space, message] of app.messages) {
  await configureSpectrum.handle(space, message, async (ctx) => {
    const { profile } = await ctx.profile.read();
    await message.reply(await runAgent({ message, profile }));
  });
}
```

Existing Spectrum apps can add only the adapter. New apps should install Spectrum according to Photon's docs before adding this package.

`store` should be durable in production. Use `memoryStore()` only for local development.

## Boundaries

- Spectrum remains the messaging runtime.
- This package does not construct a Spectrum app.
- This package does not re-export Spectrum providers, content builders, webhook adapters, or runtime APIs.
- `spectrum-ts` is a peer dependency. Existing apps keep their own compatible Spectrum version.
- Configure `sk_` keys stay server-side. Publishable `pk_` keys are only used to build hosted sign-in URLs.

## Local Development Store

```ts
import { memoryStore, withConfigure } from "@configure-ai/spectrum-ts";

const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store: memoryStore(),
});
```

`memoryStore()` is for local development and examples. Use a durable store in production so sign-in tokens, journeys, and webhook idempotency survive restarts.

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

## Stability

This package is pre-1.0. APIs may change before `1.0`; breaking changes will be documented in `CHANGELOG.md`.
