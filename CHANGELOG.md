# Changelog

## Unreleased

- **Wire fix:** the message URL API payload now sends the Photon-signed evidence as `messageSenderProof` and parses `sender_proof_missing | sender_proof_invalid | sender_proof_unsupported` fallback reasons, matching the shipped backend (`subjectToken`/`subject_signature_*` from earlier spec drafts were never accepted on the wire and would have silently pinned auto mode to plain links). Legacy `subject_signature_*` responses are still mapped. `ConfigureSpectrumMessageUrlFallbackReason` values changed accordingly; the `identity.subjectToken` option keeps its name.
- Default identity extraction also recognizes `messageSenderProof`/`message_sender_proof`/`senderProof`/`sender_proof` fields in Spectrum message/space metadata.
- Docs: Photon project-credential provisioning (`docs/photon-provisioning.md`) — exchange `PHOTON_PROJECT_ID`/`PHOTON_PROJECT_SECRET` for `CONFIGURE_*` credentials with one call — and a paste-able coding-agent quickstart (`docs/coding-agent-quickstart.md`).

## 0.1.0-preview.0

- Initial private preview scaffold for `@configure-ai/spectrum-ts`.
- Adds the `withConfigure()` adapter, explicit store contract, `withConfigure.localStore()` for local development, framework-neutral completion helper, and typed Spectrum handler context.
- Tightens stored-token validation, avoids exposing raw phone candidates on handler subject context, and updates examples around `ctx.linked` plus profile-based personalization.
- `ctx.signInUrl()` returns a clean `sign-in.me/<agent>` for the plain message flow — the hosted OTP flow is public, so the publishable key and query params are vestigial. The verbose form (pk + journey + connectors) is used only when a `messageCompleteUrl` journey is configured or explicit overrides are passed.
- Clarifies private preview tarball installation until npm publish.
