# Bringing Configure to Maritime: what you build, what we return

Status: **implemented, deploying behind the partner key exchange**. One endpoint, one synchronous call.
Endpoint: `POST https://api.configure.dev/v1/maritime/installations`

## What this is

In your UI, a developer turns on personalization for an agent. Your backend
makes **one POST** to Configure with the developer's verified email and the
agent's stable id and name. **The keys come back in the response to that same
POST** — no callback, no webhook, no polling, nothing for us to call on your
side. You show the keys once, inject them into the agent's environment, and
you're done.

**Scope: this doc does not cover your UI.** The toggle, the copy, where the
panel lives — all yours. This covers only the calls, when to make them, and
what comes back.

## The flow

```
developer flips the toggle
        │
        ▼
your backend ── POST /v1/maritime/installations ──▶ Configure
        ◀───────────── 201 + keys (same response) ──┘
        │
        ├─ render keys + setup steps in your UI (secret is shown ONCE)
        └─ inject env into the agent's VM (CONFIGURE_API_KEY as a secret)
```

Auth on every call: `Authorization: Bearer <your partner key>`. The partner
key lives **only in your backend** — it must never reach a browser.

## The exchange

```bash
curl -s -X POST https://api.configure.dev/v1/maritime/installations \
  -H "Authorization: Bearer $CONFIGURE_PARTNER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "maritime_agent_id": "<stable base-agent/project id>",
    "email": "dev@example.com",
    "email_verified": true,
    "agent_name": "support-bot",
    "maritime_user_id": "mu_123"
  }'
```

First call (HTTP 201):

```jsonc
{
  "ok": true,
  "created": true,
  "account_existed": false,          // true = this email already had a Configure account; we attached
  "agent": "support-bot",            // the Configure handle, derived from agent_name
  "agent_display_name": "support-bot",
  "secret_key": "sk_…",              // shown ONCE — stored hashed on our side, never re-shown
  "publishable_key": "pk_…",
  "developer_account_id": "…",
  "installation": {
    "id": "…",
    "maritime_agent_id": "…",
    "status": "active",
    "claim_status": "unclaimed",
    "kind": null
  },
  "sign_in_url": "https://sign-in.me/support-bot",
  "claim_url": "https://configure.dev/login",
  "env": {                            // paste-ready; inject into the agent VM
    "CONFIGURE_AGENT": "support-bot",
    "CONFIGURE_API_KEY": "sk_…",
    "CONFIGURE_PUBLISHABLE_KEY": "pk_…"
  },
  "setup_steps": ["…"]                // render these under the keys; wording is ours to update
}
```

Every later call with the same `maritime_agent_id` is an idempotent upsert
(HTTP 200, `created: false`, `secret_key: null`). Lost key? Pass
`{"rotate_api_key": true}` — the new key is in that response and the old one
is already revoked, so re-inject env and restart the agent in the same flow.

`GET /v1/maritime/installations/current?maritime_agent_id=…` is the read-only
status echo for page loads. It never returns keys; 404 means the toggle is off.

### Request fields

| Field | When | Purpose |
|---|---|---|
| `maritime_agent_id` | always | The **stable base-agent/project id** — the idempotency key. Must survive customer scaling; never a per-customer instance id. |
| `email` | first call | Owner of the Configure account. If it already has one, we **attach** the new agent + keys to it (never a 409). |
| `email_verified` | with `email` | Must be `true`, and only when the email comes from a verified login on your side — never a free-text field. We refuse account work without it. |
| `agent_name` | recommended | The agent's name in your product; we derive the Configure handle from it. |
| `maritime_user_id` | recommended | Your user id, for support lookups. |
| `display_name`, `agent` | optional | Display-name override / explicit Configure handle. |
| `kind` | optional | `"personal"` \| `"product"` — the provisioning question's answer; can arrive on any later upsert and switches the `setup_steps` framing. |
| `status` | optional | `"disabled"` on toggle-off, `"active"` to re-enable. Bookkeeping only — keys are never revoked by toggle state; rotation is the revocation path. |
| `rotate_api_key` | optional | Mint a replacement secret key; the previous maritime-issued one is revoked atomically. |

The body is strict: an unknown field is a 400, not silently ignored.

## When you call us — the complete matrix

| Event in Maritime | What you do |
|---|---|
| Toggle ON, first time | `POST` with email + `email_verified` + id + name → 201, keys once |
| Developer toggles a **second** agent | same `POST`, new id, same email → new agent + keys on the same account |
| Settings edit / rename / question answered | `POST` with the changed fields → 200 upsert |
| Toggle panel page load | `GET /current` (404 = render OFF) |
| Lost key | `POST` `rotate_api_key: true` → re-inject env same flow |
| Toggle OFF / agent deleted | `POST` `status: "disabled"`, stop injecting env |
| Timeout / concurrent race (409) | retry the same `POST` — it's idempotent |
| Developer's email changes later | nothing — a different email on a repeat call is ignored and flagged (`email_mismatch: true`); the account stays with the first-provision email |
| **New customer instance spins up** | **no call to us** — inject the same env into the instance via your env API (template snapshots blank secret values, so this injection is yours on every instance) |

## Errors

| Status | Meaning | Do |
|---|---|---|
| 401 `api_key_missing` / `api_key_invalid` | Bearer missing or wrong | Check the partner key |
| 400 `missing_field` | First call without `email` / `email_verified` | Add them from the verified session |
| 400 on a field name | Strict body caught a typo | Fix the field |
| 409 | Concurrent first-provision race | Retry once |
| 503 | Lane disabled on this deployment | Contact Configure |

## What you build (all of it)

1. **One backend route** that proxies your toggle to this endpoint, holding the
   partner key server-side.
2. **Your toggle UI** (out of scope here) that renders the response: keys once,
   `setup_steps`, and a claim button pointing at `claim_url`.
3. **Env injection**: write the `env` block into the agent's VM —
   `CONFIGURE_API_KEY` as a secret — on provision, on rotation, and on every
   per-customer instance you spin up.

That's the whole integration. The developer's agents get the Configure skill
separately (it teaches the agent-side pattern); this endpoint's `setup_steps`
point them to it.

## Security properties

- **Partner key never reaches a browser**; your backend is the only caller.
- **`email_verified` is a hard gate**: a forged email would mint keys into
  someone else's Configure account, so we only do account work on emails you
  assert came from a verified login.
- **Secret keys are hashed at rest** — the 201 is the only time the secret
  exists in plaintext outside your infrastructure; rotation revokes the
  predecessor atomically.
- **Recognition is never authorization**: provisioning creates the agent and
  keys; every end user still approves the agent individually on Configure's
  hosted sign-in surface before any personal profile is readable.
