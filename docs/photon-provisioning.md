# Provisioning Configure from Photon Project Credentials

Status: built, **not yet live** — ships with memory-link PR #126 (currently open; its migration needs renumbering past 088). Until that PR deploys, `POST https://api.configure.dev/v1/photon/installations` returns 404. This page is the agreed contract for that endpoint.
Endpoint: `POST https://api.configure.dev/v1/photon/installations`

## What this is

A Spectrum app already holds a Photon project credential pair:

```
PHOTON_PROJECT_ID=7d444840-…
PHOTON_PROJECT_SECRET=ps_…
```

Photon's own API authenticates with that pair as `Authorization: Basic base64(projectId:projectSecret)` — for example `GET /projects/{projectId}/`. Configure accepts the same credential shape on one endpoint and verifies it by replaying it against Photon's `getProject`: if the call succeeds, the caller controls the project. That proof replaces signup, dashboard visits, and OTP. One request returns everything `withConfigure` needs:

- a Configure developer account (provider `photon`, unclaimed until the developer logs in),
- an agent whose handle, display name, and logo come from the Photon project's display name and sender profile,
- an `sk_` secret key and `pk_` publishable key,
- the hosted sign-in URL (`https://sign-in.me/{agent}`).

The same endpoint serves the Photon platform when the dashboard toggle provisions on the developer's behalf. The two paths converge on the same installation row, keyed on the Photon project id.

## The exchange

```bash
curl -s -X POST https://api.configure.dev/v1/photon/installations \
  -u "$PHOTON_PROJECT_ID:$PHOTON_PROJECT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

First call (HTTP 201):

```jsonc
{
  "ok": true,
  "created": true,
  "agent": "parry",
  "agent_display_name": "Parry",
  "secret_key": "sk_…",            // shown once — stored hashed server-side
  "publishable_key": "pk_…",
  "developer_account_id": "…",
  "installation": {
    "id": "…",
    "photon_project_id": "…",
    "status": "active",
    "claim_status": "unclaimed",
    "imessage_synced": true,
    "photon_display_name": "Parry"
  },
  "sign_in_url": "https://sign-in.me/parry",
  "env": {                          // paste-ready for .env
    "CONFIGURE_AGENT": "parry",
    "CONFIGURE_API_KEY": "sk_…",
    "CONFIGURE_PUBLISHABLE_KEY": "pk_…"
  }
}
```

Every later call is an idempotent upsert on the project (HTTP 200, `created: false`): it re-verifies the credentials, refreshes the Photon-derived metadata (`photon_display_name`, `imessage_synced`), and returns the installation **without** the secret key — secret keys are stored hashed and cannot be re-shown. Lost the key? Pass `{"rotate_api_key": true}` to mint a replacement; the previous photon-issued secret key is revoked in the same transaction, so rotate and redeploy together.

`GET /v1/photon/installations/current` with the same Basic header is the status echo. It never returns keys.

### Request body

All fields optional except `email` on the first call.

| Field | Purpose |
|---|---|
| `email` | Owner of the created Configure developer account. Required first call only. If the email already has a Configure account, the call returns `409 already_registered` with routing (add the agent from that account via `POST /v1/developer/agents`, or use another email) — it never silently attaches to an existing account. |
| `agent` | Requested handle (lowercase, 2–63 chars, hyphens). Omitted: derived from the Photon project display name, uniquified on collision. |
| `display_name` | Override the agent display name. Default: Photon project display name, then sender profile name. |
| `owner_id`, `photon_agent_id` | Photon platform bookkeeping ids, stored on the installation. Used by the dashboard toggle; terminal callers can omit. |
| `policy` | `{ sign_in: "first_message" \| "when_needed" \| "gate", memory: "automatic" \| "tool_directed" \| "off", connectors: [...] }` — stored for the toggle runtime. |
| `rotate_api_key` | Mint a replacement `sk_` and revoke the previous photon-issued one. |

The body is validated strictly: unknown fields are a `400`, not silently ignored.

### Errors

| Status | Meaning | Do |
|---|---|---|
| 401 `api_key_missing` | No/malformed Basic header | Send `-u "$PHOTON_PROJECT_ID:$PHOTON_PROJECT_SECRET"` |
| 401 `api_key_invalid` | Photon rejected the credentials | Check the env pair against the Photon dashboard |
| 400 `missing_field` (email) | First-time provisioning without an email | Add `{"email": …}` |
| 409 `already_registered` | Email already has a Configure account | Use `POST /v1/developer/agents` with that account's key, or another email |
| 502 `service_unavailable` | Photon unreachable during verification | Retry shortly — installations are never created on unverified credentials |
| 503 | Photon provisioning disabled on this Configure deployment | Contact Configure |

## Security properties

- **The project secret is proof, not property.** Configure uses it transiently for the one upstream `getProject` call and never stores or logs it. Verified results are cached for 60 seconds (in memory, keyed by credential hash) so deploy loops don't hammer Photon.
- **The Photon API base URL is pinned server-side** (`PHOTON_API_BASE_URL`); nothing in the request can steer the verification call at another host.
- **Fail closed.** Photon down ⇒ retryable 502, no installation, no account.
- **Secret keys are hashed at rest** — the 201 is the only time `secret_key` exists in plaintext outside your infrastructure. Rotation revokes the predecessor atomically.
- **Recognition is never authorization.** Provisioning creates the agent and keys; every end user still approves the agent individually on the hosted sign-in surface before any personal profile is readable.

## Relation to the dashboard toggle

When Photon builds the Configure toggle, its backend calls this same endpoint on toggle-on and settings edits, passing the richer body (`owner_id`, `photon_agent_id`, `policy`, sign-in copy settings). A developer who provisioned from the terminal first and later flips the toggle lands on the same installation — same agent, same users, same memory. Claiming the account from the dashboard attaches a normal Configure login to it; it never creates a second account.
