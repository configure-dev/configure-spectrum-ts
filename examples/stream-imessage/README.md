# Stream iMessage Example

This example shows the adapter inside an existing Spectrum message loop.

For Spectrum iMessage dedicated-line spaces, the adapter uses Spectrum's routed `space.phone` value for Configure's hosted sign-in return behavior. If your Photon setup exposes the current line through an API instead, pass `signIn.agentPhone` as an async resolver around that API. The example does not need a separate Configure message-line phone environment variable.

The example uses `withConfigure.localStore()` for local development. When deploying, back the store with the persistence your app already uses for server-side state.
