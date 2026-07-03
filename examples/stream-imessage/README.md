# Stream iMessage Example

This example shows the adapter inside an existing Spectrum message loop.

For Spectrum iMessage dedicated-line spaces, the adapter uses an explicit `signIn.agentPhone` first, then falls back to Spectrum's routed `space.phone` value for Configure's hosted sign-in return behavior. If your Photon setup exposes the current line through an API, pass `signIn.agentPhone` as an async resolver around that API. In `linkMode: "managed"`, the adapter registers that line with Configure before requesting a message URL, so the example does not need a separate Configure message-line phone environment variable.

The example uses `withConfigure.localStore()` for local development. When deploying, back the store with the persistence your app already uses for server-side state.
