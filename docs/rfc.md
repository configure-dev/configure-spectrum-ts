# Configure + Spectrum Adapter RFC

`@configure-ai/spectrum-ts` is a server-side adapter for applications already using `spectrum-ts`.

The adapter accepts Spectrum `space` and `message` objects, resolves the sender with the Configure SDK, and returns a Configure profile runtime for the current turn. Spectrum continues to own transport, providers, replies, and webhooks.

## Public Shape

```ts
import { withConfigure } from "@configure-ai/spectrum-ts";

const configureSpectrum = withConfigure({
  apiKey,
  publishableKey,
  agent,
  store,
});

await configureSpectrum.handle(space, message, async (ctx) => {
  const { profile } = await ctx.profile.read();
  await runAgent({ message, profile });
});
```

## Non-Goals

- Constructing or owning the Spectrum app.
- Re-exporting Spectrum APIs.
- Parsing or verifying Photon webhooks.
- Owning the model loop.
- Hiding production persistence behind an implicit in-memory store.
- Treating phone recognition as authorization.

## V0.1 Decisions

- `connect.mode` defaults to `manual`.
- v0.1 includes the framework-neutral `configureSpectrum.complete()` helper only.
- Default subject keys hash phone material.
- Stored token validation defaults to `on-first-use`.
- `spectrum-ts` is a peer dependency.
- `configure` is a runtime dependency.
