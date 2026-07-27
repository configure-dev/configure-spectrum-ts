# The return trip — getting the assistant's output back into Configure in one tap

The prompt going *out* is easy (Configure pre-fills it). The friction is the
memory coming *back*: today it's copy → switch apps → paste → wait. Here are the
two ways to make that **one tap**, both feeding the ingest + redirect already in
this package. Neither needs the assistant to do anything it refuses.

## Option 1 — Share to Configure (universal, mobile-native) ✅ recommended

Every assistant will *print* the memory as text. On a phone, the user selects that
output and taps **Share → Configure** — Configure receives it and imports it. No
copy, no app-switch, no held clipboard. Works with **any** model, because the model
only had to print text (it never has to build a link or send anything).

Wire Configure (as an installed PWA) to be a share target, pointed straight at the
ingest route:

```json
// Configure web app manifest.json
{
  "share_target": {
    "action": "/sync/<token>/ingest",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": { "title": "title", "text": "text", "url": "url" }
  }
}
```

`/{token}/ingest` now parses that share POST directly (form fields `title`/`text`/
`url`, optional `source`) — no glue code — commits the memory, and (with a bound
`redirectUrl`) 302s back into onboarding. The token can be carried in the action
URL per import session.

Native apps: register an iOS Share Extension / Android `ACTION_SEND` receiver that
POSTs the shared text to the same endpoint.

## Option 2 — Tap-to-save link (one tap, when the model cooperates)

If the extraction prompt asks the assistant to output a **"Save to Configure"
link** (`ticket.tapLinkPrompt`), the user just taps it → ingested → redirected to
onboarding. Zero even-select. Reliability varies: assistants build the link from
memory that's visible in the chat, but some (notably ChatGPT) refuse to turn their
*hidden* saved-memory into a link — in which case they still print it as text and
Option 1 takes over. So ship Option 2 as the happy path and Option 1 as the
always-works fallback.

## Option 3 — Paste & Import (desktop)

A Configure button that reads the clipboard (`navigator.clipboard.readText()`),
so after the user copies the assistant's output they tap once in Configure instead
of clicking into a field and pasting. Good desktop fallback where there's no share
sheet.

## The resulting flow (prompt already pre-filled)

```
1. [pre-filled] assistant runs the extraction prompt, prints the memory
   (and, happy path, a "Save to Configure" link)
2. ONE tap home:
     • tap the link                         (Option 2), or
     • select output → Share → Configure    (Option 1, always works), or
     • copy → Configure "Paste & Import"     (Option 3, desktop)
3. Configure ingests → redirects into onboarding (?memory_synced=N&source=…)
```

All three land at `POST/GET /{token}/ingest` → `profile.commit({ memories })` →
302 to `redirectUrl`. That server side is built and tested in this package; Options
1 and 3 (share target, paste button) are small Configure-frontend additions.
