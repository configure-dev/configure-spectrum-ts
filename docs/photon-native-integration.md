# Native Photon Integration

This document defines the platform contract for adding Configure to agents hosted by Photon. Photon owns orchestration and delivery. Configure owns installation provisioning, sender resolution, sign-in, scoped MCP access, and memory ingestion.

This is the recommended integration for Photon-hosted agents. The `configure-spectrum` package is a separate SDK adapter for applications that own their own Spectrum message loop.

## Runtime Sequence

```text
Toggle enabled
  Photon -> POST /v1/photon/installations -> Configure installation

Inbound message
  Photon -> POST /v1/photon/sessions
    reply mode   -> send reply_text; do not run the model
    session mode -> attach mcp_servers; run the model; deliver its reply

Delivered model reply
  Photon -> POST /v1/photon/turns -> Configure accepts memory work asynchronously
```

Photon calls all endpoints from its backend. Never expose project secrets, Configure session tokens, or MCP authorization tokens to client-side code.

## Authentication

Every request uses the Photon project's existing credentials:

```http
Authorization: Basic base64(PHOTON_PROJECT_ID:PHOTON_PROJECT_SECRET)
```

Configure verifies the credentials against Photon's `getProject` endpoint during provisioning. Runtime requests normally use the stored project-secret hash and do not call Photon. If the secret changes, Configure verifies it once and updates the stored hash.

The base URL is `https://api.configure.dev`.

## 1. Create or Update an Installation

Call this endpoint when the developer enables Configure. Call it again when Configure settings change.

```http
POST /v1/photon/installations
Content-Type: application/json
Authorization: Basic …
```

```json
{
  "email": "owner@example.com",
  "photon_agent_id": "agent_123",
  "owner_id": "owner_123",
  "sign_in_copy": "Connect your Configure profile: {url}",
  "policy": {
    "sign_in": "first_message",
    "memory": "automatic",
    "connectors": ["gmail", "calendar"]
  }
}
```

`email` is required only when the Photon project does not yet have a Configure developer account. `photon_agent_id` defaults to `"default"`; Photon should provide its stable agent identifier when a project can contain more than one agent.

The operation is idempotent for each `(Photon project, Photon agent)` pair. It creates or updates:

- One Configure developer account per Photon project.
- One Configure agent per Photon agent.
- The sign-in and memory policy used by the runtime endpoints, plus the requested connector policy for the Photon control plane.
- Configure credentials for developers who also use the SDK adapter.

Secret keys are returned only when created or explicitly rotated. Photon does not need the returned Configure secret key for the native MCP runtime.

See [Photon provisioning](photon-provisioning.md) for the complete request, response, rotation, and error contract.

### Policy Values

| Field | Value | Runtime behavior |
| --- | --- | --- |
| `sign_in` | `first_message` | Return one sign-in reply for an unlinked sender, then allow unlinked model sessions. This is the default. |
| `sign_in` | `when_needed` | Always run the model. The unlinked MCP session can produce a sign-in link with `configure_connect`. |
| `sign_in` | `gate` | Return the sign-in reply until the sender approves the agent. |
| `memory` | `automatic` | Accept delivered turns for asynchronous memory extraction. This is the default. |
| `memory` | `tool_directed` | Do not ingest turns automatically. The model controls memory through MCP tools. |
| `memory` | `off` | Do not ingest turns automatically. |

## 2. Request a Session for Each Message

Call the session endpoint before every model invocation.

```http
POST /v1/photon/sessions
Content-Type: application/json
Authorization: Basic …
```

```json
{
  "photon_agent_id": "agent_123",
  "sender": {
    "phone": "+14155550123"
  },
  "message_id": "message_123",
  "channel": "imessage",
  "receiving_line": "+14155550199"
}
```

Requirements:

- `sender.phone` must be a provider-verified sender number. User-authored message content must never supply it.
- `message_id` should be the stable Photon message identifier. It makes the first-message sign-in response safe to retry.
- `photon_agent_id` must match the installation. Omit it only for the default installation.
- `channel` and `receiving_line` are accepted as optional message metadata. They do not change current session behavior.

The response has one of two modes.

### Reply Mode

```json
{
  "ok": true,
  "mode": "reply",
  "reason": "sign_in_offer",
  "policy": "first_message",
  "reply_text": "Connect your Configure profile: https://sign-in.me/example-agent",
  "sign_in_url": "https://sign-in.me/example-agent"
}
```

Send `reply_text` through the inbound channel and stop processing the message. Do not run the model for this turn.

### Session Mode

```json
{
  "ok": true,
  "mode": "session",
  "linked": true,
  "display_name": "Avery",
  "session": {
    "token": "opaque-short-lived-token",
    "expires_at": "2026-07-21T21:00:00.000Z"
  },
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://api.configure.dev/mcp",
      "name": "configure",
      "authorization_token": "opaque-short-lived-token"
    }
  ]
}
```

Pass `mcp_servers` to the model invocation without changing its fields. Configure currently issues a 15-minute token. Treat it as message-scoped: do not decode it, persist it, log it, or reuse it for another turn.

An unlinked sender can also receive `mode: "session"`. In that case, `linked` is `false`; personal tools fail closed, while `configure_connect` can create the hosted sign-in link. Do not infer access from the presence of an MCP server.

## 3. Submit the Delivered Turn

After the model response is delivered successfully, submit the bounded turn:

```http
POST /v1/photon/turns
Content-Type: application/json
Authorization: Basic …
```

```json
{
  "photon_agent_id": "agent_123",
  "sender": {
    "phone": "+14155550123"
  },
  "message_id": "message_123",
  "user_message": "Please remind me that I prefer morning flights.",
  "agent_reply": "I will keep that preference in mind."
}
```

Configure returns `202` after authentication. The response states whether the turn was accepted:

```json
{ "ok": true, "accepted": true }
```

`accepted: false` is expected when automatic memory is disabled, the sender has not approved the agent, or the message was already submitted. Configure does not retain unapproved senders' message content.

The endpoint is idempotent by installation and `message_id`. Retry transient failures with the same identifier. Do not submit sign-in-only replies or failed deliveries.

## Failure Behavior

| Status | Meaning | Photon behavior |
| --- | --- | --- |
| `400` | Invalid request | Do not retry until the request is corrected. |
| `401` | Missing or rejected project credentials | Disable the integration for that request and surface a configuration error. |
| `403` | Installation disabled | Do not call the model with Configure attached. |
| `404` | Installation not found | Provision the installation, then retry. |
| `429` | Project rate limit reached | Retry with bounded backoff. |
| `502` | Photon verification was temporarily unavailable | Retry with bounded backoff. |
| `503` | Photon integration disabled in this Configure environment | Surface an environment configuration error. |

If the session exchange fails, Photon may run the agent without Configure only when the product policy explicitly permits that fallback. Never reuse an earlier sender's MCP block.

## Acceptance Checklist

- Enabling the toggle provisions one installation and repeated calls do not create duplicates.
- An approved sender receives `mode: "session"`, and the returned MCP tools can read only that sender's permitted data.
- A new sender receives the configured sign-in behavior.
- An unlinked session cannot read personal data.
- `mode: "reply"` bypasses the model and sends `reply_text` once for `first_message`.
- The MCP block is attached only to the model turn for which it was issued.
- A delivered turn returns `202`; repeating its `message_id` does not create duplicate memory.
- Logs and analytics contain no project secrets, phone numbers, MCP tokens, or message bodies.

## Photon Implementation Scope

Photon needs to implement:

1. Configure toggle and policy fields in the Photon interface.
2. Installation calls on enable and settings changes.
3. The session call and its `reply`/`session` branch before model execution.
4. Direct attachment of the returned MCP block to the model call.
5. Turn submission after successful delivery when automatic memory is enabled.

Photon does not need to implement an MCP server, issue Configure tokens, create Configure users, or embed the `configure-spectrum` SDK adapter in its hosted runtime.
