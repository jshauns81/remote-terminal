# Tier 2 — solid quality wins

Items 7 and 8 are trivial and infra-independent — do them anytime. Items 5 and 6 touch
live behavior (Zellij, mobile paste) and should be verified on the server / a real phone.

---

## T2.5 — Tab-state desync (client bar reflects real Zellij tab)  ⚠ infra-coupled

**What / why.** The HTML tab bar is purely client-driven: `selectTab()` in `nexus.js`
writes `Alt+<n>` bytes and optimistically flips `aria-selected`. If you switch tabs
**inside** Zellij with the keyboard, the top bar keeps highlighting the wrong tab and the
`wake` button (shown only on the `llm` tab) shows/hides incorrectly. The client's idea of
the active tab and Zellij's real state diverge.

**Approach options (pick per what you can wire up on the server).**

1. **Detect from Zellij (preferred).** Zellij can surface the active tab name. Simplest
   robust path: have panes set the terminal title per tab (an OSC `\x1b]0;llm\x07` on
   pane focus, or a Zellij plugin/hook), intercept the title-set sequence in `term.onData`
   client-side, and update the bar from the real name. Requires experimenting against a
   live Zellij to find the cleanest signal — hence infra-coupled.
2. **Lightweight fallback.** If a reliable active-tab signal is impractical, at minimum
   make the bar honest on reconnect: don't assume tab 1 is active after `term.reset()`.

**Files.** `public/nexus.js` (parse the signal, drive `selectTab`), possibly
`zellij/layouts/nexus.kdl` or `zellij/config.kdl` (emit the signal).

**Verification.** Switch tabs via the Zellij keybind and confirm the HTML bar + wake
button track it; switch via the HTML bar and confirm no regression.

---

## T2.6 — Paste affordance + wider ctrl-combo coverage  ⚠ partly infra-coupled (mobile)

**What / why.** Copy-on-select exists (`term.onSelectionChange` → clipboard) but there is
**no paste affordance** — pasting into xterm on mobile is painful. Also, sticky-ctrl only
composes with a single printable key (`d.length === 1` in `term.onData`); it can't do
`Ctrl+arrow`, and there's no way to send `Ctrl+C` while also hitting an aux key.

**Files.** `public/index.html` (aux-strip paste button), `public/nexus.js` (paste handler;
extend ctrl handling to aux keys), `public/style.css` (button styling — reuse `.key`).

**Implementation sketch.**

Paste button in the aux strip (`index.html`, near `esc`/`tab`):
```html
<button class="key" data-key="paste">paste</button>
```
`nexus.js` — in the aux-key handler, special-case it:
```js
if (k === "paste") {
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText()
      .then((t) => { if (t) sendInput(t); })
      .catch((err) => console.error("[nexus] paste failed:", err));
  }
  term.focus();
  e.preventDefault();
  return;
}
```
Wider ctrl coverage — when `ctrlArmed`, also transform the arrow/aux escape sequences
(e.g. `Ctrl+arrow` → `\x1b[1;5C` etc.) instead of only printable keys. Keep the existing
single-printable path.

**Verification.** On a phone: select copies, paste button inserts clipboard text into the
shell. `Ctrl+C` interrupts; armed-ctrl + arrow sends the modified sequence.

---

## T2.7 — Docker `HEALTHCHECK` + `SIGTERM` graceful shutdown

**What / why.** `/healthz` exists but nothing consumes it — there's no Docker
`HEALTHCHECK`, so `restart: unless-stopped` can't tell a wedged process from a healthy
one. And there's no `SIGTERM` handler, so `docker stop` kills the process mid-flight
instead of closing the WSS/heartbeat cleanly.

**Files.** `Dockerfile` (or `docker-compose.yml`) for the healthcheck; `server/index.js`
for the signal handler.

**Implementation sketch.**

`Dockerfile` (before `CMD`):
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||7681)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
```
`server/index.js` (bottom):
```js
function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) { try { ws.close(); } catch (_) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref(); // don't hang on a stuck socket
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```
Note: `node-pty` children are per-connection and killed on `ws.close`; Zellij persists
server-side regardless, so shutdown does not touch terminal state.

**Verification.** `docker inspect` shows the container as `healthy`; `docker stop` exits
promptly (well under the 10s default kill timeout) with sockets closed.

---

## T2.8 — `immutable` caching for `/vendor/*`, keep `no-store` for HTML

**What / why.** The static handler sends `cache-control: no-store` for **everything**,
so the vendored xterm JS and the ~Nerd Font woff2 are re-downloaded on every page load.
Correct for `index.html` (must always be fresh), wasteful for immutable vendored assets.

**Files.** `server/index.js` — the static-file `writeHead` branch.

**Implementation sketch.**
```js
const reqPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
// ... existing filePath resolution ...
const longCache = reqPath.startsWith("/vendor/");
res.writeHead(200, {
  "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
  "cache-control": longCache
    ? "public, max-age=31536000, immutable"
    : "no-store",
});
```
`/vendor/*` is safe to cache forever because those files only change on a rebuild that
ships a new image. If you later want cache-busting on app updates, add a `?v=<hash>` query
to the vendor `<script>`/`<link>` tags — but that's optional and not required here.

**Verification.** Devtools Network: first load fetches `/vendor/*` (200), reload serves
them from disk/memory cache; `index.html` is always re-fetched (200, no-store).
