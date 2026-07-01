# Changelog

## 0.1.0-preview.0

- Initial private preview scaffold for `@configure-ai/spectrum-ts`.
- Adds the `withConfigure()` adapter, explicit store contract, dev-only `inMemoryStore()`, framework-neutral completion helper, and typed Spectrum handler context.
- Tightens stored-token validation, avoids exposing raw phone candidates on handler subject context, and updates examples around `ctx.linked` plus profile-based personalization.
- `ctx.signInUrl()` returns a clean `sign-in.me/<agent>` for the plain message flow — the hosted OTP flow is public, so the publishable key and query params are vestigial. The verbose form (pk + journey + connectors) is used only when a `messageCompleteUrl` journey is configured or explicit overrides are passed.
