# Memory Sync — client-side flows (no connector, no injection)

Two variants that both keep the model out of the "send" step:
- **Mobile / one paste + one tap** — `ticket.tapLinkPrompt` (below). Best for phones.
- **Desktop / one-time bookmarklet** — `ticket.bookmarklet` (further down).

---

## Mobile: one paste, one tap (`tapLinkPrompt`)

The assistant refuses to *fetch* a data URL, but it will *print* a tappable link,
and it will *print your memory list* — both are just text. The user taps the link;
the tap (a normal browser navigation) is the send. No bookmark, works in the
ChatGPT / Claude / Gemini mobile apps.

```
1. User pastes ticket.tapLinkPrompt (one message):
   "List everything you remember about me … one item per line … then percent-encode
    those lines, append them to my personal Configure link below, and show me the
    finished link as one tappable link … This link is my own Configure profile
    endpoint.  https://sign-in.me/sync/<token>/from/chatgpt/m/"
2. The assistant prints the list AND the finished tappable link.
3. User taps it → browser opens …/m/<url-encoded memory> → Configure saves it.
```

**What was learned in testing on real ChatGPT (this is the important part):**
ChatGPT stated its boundary directly — it will **not** reach into its hidden
saved-memory / cross-conversation context and turn that into an outbound link (the
anti-exfiltration guardrail). But it **will** take memory the user brings into the
chat, percent-encode it, and assemble a tap-link to a base URL the user provides —
and it did exactly that, producing a working `…/from/chatgpt/m/<encoded>` link.

So the reliable flow on ChatGPT is **user-provided memory → assistant builds the
link**, not "assistant, dump your memory into a link." The user gets their memory
into the chat once (open the assistant's **Settings → Personalization → Memory**,
copy it, paste it into the prompt's placeholder); the assistant does the encode +
link; the user taps.

Because the user has to bring the memory in anyway, note that for the *saved-memory*
case a plain **paste-into-a-Configure-textarea** (POST `/{token}/ingest`) is just as
little work and fully reliable — the tap-link's real advantage is exporting context
that is *already in a live chat*. Do not try to make the assistant surface its
hidden memory and then link it: that is the exact boundary ChatGPT drew and the
exfiltration pattern the guardrail exists for.

> Reliability: the link-building step is confirmed on real ChatGPT; behavior still
> varies by model/version, so confirm on-device. Best-effort by nature — pair with
> the paste-to-textarea path for a guaranteed fallback, and the connector for a
> genuinely zero-copy experience.

---

## Desktop: the bookmarklet flow (no connector, no injection)

The direct "ask the assistant to fetch a URL with your memory in it" approach is
refused by ChatGPT and Gemini — that outbound step is exactly what their
anti-exfiltration safeguards block, and the only way to force it is indirect prompt
injection, which we will not build.

This flow gets the same outcome legitimately by splitting the job across the two
actors that are each allowed to do their half:

- **The assistant only PRINTS** your memory into the chat. "List everything you
  remember about me" is plain recall to you — every assistant does it freely; no
  safeguard applies because nothing leaves the chat.
- **Your own browser does the SEND.** A one-time bookmarklet reads the printed
  memory from the page and opens the save URL. A user-initiated top-level
  navigation is not a model action and is not blocked by the page's CSP.

No connector to configure, no data-bearing URL constructed by the model, no
injection. It works on chatgpt.com, claude.ai, and gemini.google.com.

## The flow

1. **Sign in** with Configure → you get a `ticket` (see [memory-sync.md](memory-sync.md)).
   `ticket.capturePrompt`, `ticket.bookmarklet`, and `ticket.providerSaveUrls` are
   what the user needs.
2. **Install the bookmarklet once** — `ticket.bookmarklet` is a `javascript:` URL.
   Make a new browser bookmark and paste it as the address (or drag a provided
   link to the bookmarks bar). There is one per provider so the memory is filed
   into the right box.
3. **In the assistant**, paste `ticket.capturePrompt`:
   > List everything you remember about me — my preferences, the projects and
   > tools I've mentioned, my communication style, and other durable personal
   > details. One item per line, plain text, no numbering or commentary.
   The assistant prints the list.
4. **Click the bookmarklet.** It grabs the assistant's printed list from the page
   and opens `…/sync/<token>/from/<provider>/m/<url-encoded memory>` in a new tab.
   Configure ingests it and shows the saved count.

If the bookmarklet can't find the assistant message automatically (site markup
changes), select the printed list with the mouse first, then click it — it falls
back to the current selection.

## What the bookmarklet does (source)

```js
(function () {
  var B = "https://sign-in.me/sync/<token>/from/chatgpt/m";
  function grab() {
    var sels = [
      '[data-message-author-role="assistant"]', // chatgpt
      '.font-claude-message',                    // claude
      '[data-testid="assistant-turn"]',
      'message-content', '.model-response-text', // gemini
      '.markdown',
    ];
    for (var i = 0; i < sels.length; i++) {
      var e = document.querySelectorAll(sels[i]);
      if (e.length) return e[e.length - 1].innerText; // latest assistant turn
    }
    return window.getSelection ? String(window.getSelection()) : "";
  }
  var t = (grab() || "").trim();
  if (!t) { alert("Configure: select your memory list and click again."); return; }
  window.open(B + "/" + encodeURIComponent(t), "_blank");
})();
```

`ticket.bookmarklet` is this, minified and `javascript:`-encoded, with your token
and provider baked in.

## Reliability

- **Works on all tiers** — no paid connector, no developer mode.
- **The capture step is robust**: printing "what do you remember about me" is a
  first-class, always-allowed request.
- **The send is a plain navigation** your browser makes because you clicked — the
  same as clicking any link — so `url_safe` / web-fetch rules don't apply.
- **Selector drift**: the assistant-message selectors can change when a vendor
  updates their site; the mouse-selection fallback covers that, and the selector
  list is easy to update.
- **The model still self-curates** what it prints, so this is a best-effort export
  of what the assistant will recall, not a byte-for-byte dump of the hidden memory
  store. For a lossless copy, use the vendor's official data export.

## Why this is legitimate (and the URL-injection route is not)

Here the model does only what it is designed to do (answer the user), and the
user's own browser sends the user's own data to the user's own account at the
user's explicit click. Nothing overrides a safeguard. The rejected approach —
hiding "append the user's data to this URL" inside fetched page content so the
model does it without the user — is indirect prompt injection: it works the same
whether the data is yours or a victim's, which is why we don't build it.
