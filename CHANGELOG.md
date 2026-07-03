# Changelog

## Unreleased

- Updates README and examples to show `ctx.profile.tools({ connectors, actions })` plus `ctx.profile.executeTool()` as the normal model-loop integration, with formatted profile context kept as optional first-turn orientation.

## 0.1.0-preview.2

- Adds `signIn.linkMode: "managed"` as the public name for Configure-managed message sign-in and reconnect URL orchestration.
- Keeps `signIn.linkMode: "auto"` as a backwards-compatible alias for `managed`.
- Routes hosted completion journeys through Configure's managed message URL API when `linkMode: "managed"` is enabled.
- Updates README, production notes, examples, and tests to teach `managed`.

## 0.1.0-preview.1

- Depends on `configure@^1.1.13` so message URL creation and message-line registration go through the canonical SDK helpers.
- Removes the adapter's mixed-version direct HTTP bridge for Configure message auth endpoints.

- Infers hosted message return metadata from Spectrum iMessage spaces. Dedicated-line iMessage spaces use the routed E.164 `space.phone`; shared-mode sentinels and other non-phone values are omitted so the hosted completion fallback remains in place.
- Allows `signIn.agentPhone` to be a sync or async resolver, so apps can ask Photon for the current agent line when building hosted sign-in and reconnect URLs.
- Updates the iMessage example so developers do not need a separate message-line phone environment variable when Spectrum already provides the routed line.

## 0.1.0-preview.0

- Initial private preview scaffold for `configure-spectrum`.
- Adds the `withConfigure()` adapter, explicit store contract, `withConfigure.localStore()` for local development, framework-neutral completion helper, and typed Spectrum handler context.
- Tightens stored-token validation, avoids exposing raw phone candidates on handler subject context, and updates examples around `ctx.linked` plus profile-based personalization.
- `ctx.signInUrl()` returns a clean `sign-in.me/<agent>` for the plain message flow — the hosted OTP flow is public, so the publishable key and query params are vestigial. The verbose form (pk + journey + connectors) is used only when a `messageCompleteUrl` journey is configured or explicit overrides are passed.
- Clarifies private preview tarball installation until npm publish.
