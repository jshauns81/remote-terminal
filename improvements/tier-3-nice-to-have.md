# Tier 3 — nice-to-have

Lower priority. All infra-independent and safe to implement from these specs.

---

## T3.9 — Bundle a mono webfont

**What / why.** The app vendors the *Symbols* Nerd Font but the primary monospace falls
through a system stack (`"SF Mono", "JetBrains Mono", Menlo, Consolas, "Courier New",
monospace`, then the symbols font). Which font actually renders depends on the client OS,
so the terminal looks different on macOS vs. Windows vs. Android. Vendoring one real mono
webfont makes rendering identical everywhere and keeps the "no third-party CDN" property.

**Files.** `public/vendor/fonts/` (add e.g. `JetBrainsMono-Regular.woff2` +
`-Bold.woff2`), `public/style.css` (`@font-face` + put it first in `--font-mono`),
`public/nexus.js` (the `Terminal` `fontFamily` + the `document.fonts.load` warm-up),
`Dockerfile` if the font is fetched at build time rather than committed.

**Implementation sketch.** Add `@font-face` blocks next to the existing Symbols one, then:
```css
--font-mono: "JetBrains Mono", "SF Mono", Menlo, Consolas, "Courier New", monospace, "Symbols Nerd Font Mono";
```
Mirror the family string in `nexus.js`'s `Terminal({ fontFamily: ... })`, and add the new
face to the pre-draw warm-up alongside the Symbols font:
```js
Promise.all([
  document.fonts.load('14px "Symbols Nerd Font Mono"'),
  document.fonts.load('15px "JetBrains Mono"'),
  document.fonts.load('700 15px "JetBrains Mono"'),
]).then(() => term.refresh(0, term.rows - 1)).catch(() => {});
```
Watch licensing (JetBrains Mono is OFL — fine to vendor). Keep the woff2 small; only ship
the weights actually used (regular + bold).

**Verification.** Same glyph shapes across macOS/Windows/Android; Nerd Font icons still
render (Symbols font still last in the stack as the fallback for those codepoints).

---

## T3.10 — Manual "reconnect now" on the status pill

**What / why.** During a backend outage the status pill sits at "reconnecting" with
exponential backoff capped at 5s (`reconnectDelay = Math.min(reconnectDelay * 2, 5000)`).
There's no way to force an immediate retry. Making the pill clickable when disconnected is
a small nicety.

**Files.** `public/nexus.js` (click handler on `#status`), `public/style.css`
(cursor/hover only when not connected).

**Implementation sketch.**
```js
statusEl.addEventListener("click", () => {
  if (statusEl.dataset.state === "connected") return;
  clearTimeout(reconnectTimer);
  reconnectDelay = 1000;              // reset backoff on a manual attempt
  connect(true);
});
```
Add `cursor: pointer` for `.status:not([data-state="connected"])` and a subtle hover.
Optionally add a `title="click to reconnect"` when disconnected.

**Verification.** Kill the backend, confirm the pill shows "reconnecting"; clicking it
triggers an immediate attempt and resets the backoff.

---

## T3.11 — Verify resolved static path stays within `PUBLIC_DIR`

**What / why.** The static handler strips a leading `../` run
(`path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "")`) but never asserts the final
resolved path is inside `PUBLIC_DIR`. It appears safe today (absolute-URL normalize +
`path.join`), but the guarantee is *incidental*, not explicit. A `startsWith` check makes
it explicit and cheap — worth it for a root-shell-bearing app.

**Files.** `server/index.js` — the static-file branch.

**Implementation sketch.**
```js
const filePath = path.join(PUBLIC_DIR, path.normalize(reqPath).replace(/^(\.\.[/\\])+/, ""));
const resolved = path.resolve(filePath);
if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
  res.writeHead(403, { "content-type": "text/plain" });
  res.end("forbidden");
  return;
}
fs.readFile(resolved, (err, data) => { /* ... */ });
```

**Verification.** Normal assets still serve; a crafted traversal
(`/../../etc/passwd`, `/..%2f..%2fetc%2fpasswd`) returns 403, not file contents.

---

## T3.12 — `pty.spawn` try/catch closing the socket cleanly

**What / why.** In `wss.on("connection")`, `pty.spawn("zellij", ...)` runs unguarded. If
`zellij` ever fails to spawn (binary missing after a bad build, resource exhaustion), the
throw is uncaught. Wrapping it lets the socket close with a clear signal instead of an
unhandled exception.

**Files.** `server/index.js` — the connection handler.

**Implementation sketch.**
```js
let term;
try {
  term = pty.spawn("zellij", ["attach", "-c", "-f", ZELLIJ_SESSION], { /* opts */ });
} catch (err) {
  console.error("[nexus] failed to spawn zellij:", err);
  try { ws.send("\r\n[nexus] terminal backend unavailable — retrying shortly\r\n"); } catch (_) {}
  try { ws.close(); } catch (_) {}
  return;
}
```
The client's existing reconnect-with-backoff loop then handles the retry. Keep the rest of
the handler (`term.onData`, `term.onExit`, message/close wiring) unchanged.

**Verification.** Temporarily point the spawn at a nonexistent binary; confirm the client
shows the message and enters reconnect rather than the server logging an uncaught throw.
