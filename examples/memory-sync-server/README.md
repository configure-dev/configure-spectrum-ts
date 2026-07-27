# Memory Sync server (example)

A minimal, dependency-free server that lets a signed-in Configure user export
their ChatGPT/Claude memory by pasting one line — the assistant opens a URL with
the memory in the path and this server saves it to the user's Configure profile.

```bash
CONFIGURE_API_KEY=sk_... \
CONFIGURE_PUBLISHABLE_KEY=pk_... \
CONFIGURE_AGENT=your-agent \
npm run start
```

Then:

1. Open `GET /sync` — you are sent to Configure quick auth and returned to
   `/sync/complete`, which prints your personal `syncUrl` and a `prompt`.
2. Paste the `prompt` into ChatGPT or Claude.
3. The assistant recalls your memory and opens
   `GET /sync/<token>/m/<url-encoded-memories>`; the server saves it to your
   Configure profile and returns `{"ok":true,"committed":N}`.

You can try the save leg by hand:

```bash
# after minting a token via /sync/complete
curl "http://localhost:8787/sync/<token>/m/likes%20tea%0Abased%20in%20NYC"
```

See [`docs/memory-sync.md`](../../docs/memory-sync.md) for the full design.
