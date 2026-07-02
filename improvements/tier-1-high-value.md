# Tier 1 — high value, low effort

Do these first. Each is self-contained. Start with T1.1.

---

## T1.1 — WebGL renderer with canvas fallback

**What / why.** The default xterm renderer is the main source of scroll/repaint jank,
especially at the 4K/`--term-max` (~150 col) sizes this UI targets. `@xterm/addon-webgl`
moves glyph rendering onto the GPU for a large perceived-speed gain. It must load with a
fallback: WebGL context creation can fail (no GPU, context loss, some mobile browsers),
and the addon fires a `contextLoss` event we must handle by disposing and falling back.

**Files.**
- `package.json` — add dependency.
- `Dockerfile` — vendor the addon dist into `public/vendor/` (matches how xterm/fit/
  web-links are already vendored; the app must never pull JS from a CDN).
- `public/index.html` — add the `<script>` tag.
- `public/nexus.js` — load the addon after `term.open()`, with fallback.

**Implementation sketch.**

`package.json` dependencies:
```json
"@xterm/addon-webgl": "^0.18.0"
```

`Dockerfile` — extend the existing vendor block:
```dockerfile
RUN mkdir -p public/vendor/xterm public/vendor/addon-fit public/vendor/addon-web-links public/vendor/addon-webgl \
    && cp node_modules/@xterm/xterm/css/xterm.css public/vendor/xterm/ \
    && cp node_modules/@xterm/xterm/lib/xterm.js public/vendor/xterm/ \
    && cp node_modules/@xterm/addon-fit/lib/addon-fit.js public/vendor/addon-fit/ \
    && cp node_modules/@xterm/addon-web-links/lib/addon-web-links.js public/vendor/addon-web-links/ \
    && cp node_modules/@xterm/addon-webgl/lib/addon-webgl.js public/vendor/addon-webgl/
```

`index.html` — add after the `addon-web-links` script, before `nexus.js`:
```html
<script src="/vendor/addon-webgl/addon-webgl.js"></script>
```

`nexus.js` — after `term.open(document.getElementById("term"));`:
```js
// GPU renderer — big repaint/scroll win at large sizes. Guarded: WebGL context
// creation can throw, and the addon emits contextLoss (GPU reset, tab evict) which
// we must handle by disposing so xterm silently reverts to the DOM renderer.
try {
  const webgl = new WebglAddon.WebglAddon();
  webgl.onContextLoss(() => { try { webgl.dispose(); } catch (_) {} });
  term.loadAddon(webgl);
} catch (err) {
  console.error("[nexus] WebGL renderer unavailable, using DOM renderer:", err);
}
```

**Verification.** Load in a real browser; confirm no console error and text renders.
In devtools, check a WebGL context exists on the terminal canvas. Force-fail by disabling
hardware acceleration and confirm it falls back without a blank terminal.

---

## T1.2 — Commit `package-lock.json`, switch to `npm ci`

**What / why.** The Dockerfile does `COPY package.json package-lock.json* ./` (the `*`
makes the lockfile optional) followed by `npm install`. With no lockfile committed,
**every image build floats to whatever versions npm resolves that day** — a
reproducibility hole and a supply-chain risk for an app that bridges a root shell.

**Files.**
- `package-lock.json` (new, committed).
- `Dockerfile` — `npm install --omit=dev` → `npm ci --omit=dev`.

**Implementation sketch.**
```bash
cd /path/to/remote-terminal
npm install            # generates package-lock.json from the current package.json
git add package-lock.json
```
Dockerfile:
```dockerfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
```
Note: `npm ci` **requires** the lockfile to exist and match `package.json`, so drop the
optional `*`. Regenerate the lockfile whenever `package.json` changes (e.g. after adding
the WebGL addon in T1.1) and commit it.

**Verification.** `npm ci --omit=dev` succeeds locally; a clean `docker build` produces
the same dependency tree twice.

---

## T1.3 — PWA manifest + icons + apple meta + favicon

**What / why.** This is a phone-first terminal — `(pointer: coarse)` styling, safe-area
insets, a dedicated aux-key strip — but there's no way to install it. Adding a manifest +
icons + Apple standalone meta lets it "Add to Home Screen" as a fullscreen standalone app,
reclaiming browser chrome for terminal rows. High return for the mobile use case. Also
adds a favicon (there is none today).

**Files.**
- `public/manifest.webmanifest` (new).
- `public/icon-192.png`, `public/icon-512.png`, `public/favicon.svg` (new assets).
- `public/index.html` — link the manifest, favicon, and Apple meta tags.
- `server/index.js` — add `.webmanifest`/`.png` to the `MIME` map.

**Implementation sketch.**

`manifest.webmanifest`:
```json
{
  "name": "nexus",
  "short_name": "nexus",
  "display": "standalone",
  "background_color": "#05080f",
  "theme_color": "#05080f",
  "orientation": "any",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`index.html` `<head>` additions:
```html
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/icon-192.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="nexus" />
```

`server/index.js` MIME map — add:
```js
".webmanifest": "application/manifest+json; charset=utf-8",
".png": "image/png",
```

Icons: reuse the brand gradient dot on an `--ink-900` (#05080f) field — a simple SVG
exported to 192/512 PNG works. `favicon.svg` can be the gradient dot alone.

**Verification.** Chrome devtools → Application → Manifest shows no errors and the icons
resolve. On a phone, "Add to Home Screen" launches fullscreen with no address bar.

> Note: a service worker is intentionally **out of scope** — offline caching of a live
> terminal SPA adds staleness risk for no benefit. `display: standalone` + icons is
> enough to be installable.

---

## T1.4 — Origin allowlist on the WS upgrade and `/api/wake`

**What / why.** Defense-in-depth. `server.on("upgrade")` accepts any `Origin`, and
`/api/wake` is an unauthenticated `POST` at the Node layer. The app relies entirely on
the Authentik outpost in front, but a page a logged-in user visits shares the auth cookie
and could open a cross-site WebSocket (CSWSH) to the origin or fire wake packets (CSRF).
An `Origin` allowlist closes both cheaply.

**Files.**
- `server/index.js` — check `req.headers.origin` in the `upgrade` handler and in the
  `/api/wake` branch.

**Implementation sketch.**
```js
// Allowlist the origin(s) this app is actually served from. Configurable so the
// deploy hostname isn't hard-coded. Empty/unset ALLOWED_ORIGINS => allow (dev).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

function originOk(req) {
  if (ALLOWED_ORIGINS.length === 0) return true; // not configured => permissive (dev)
  const origin = req.headers.origin;
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}
```
In the `upgrade` handler, before `handleUpgrade`:
```js
if (!originOk(req)) { socket.destroy(); return; }
```
In the `/api/wake` branch, before `sendWakePacket()`:
```js
if (!originOk(req)) { res.writeHead(403); res.end("forbidden"); return; }
```
Then set `ALLOWED_ORIGINS=https://your-nexus-host` in `docker-compose.yml` env.

**Verification.** With `ALLOWED_ORIGINS` set: a WS/`/api/wake` request carrying a foreign
`Origin` header is rejected (403 / socket closed); the real app still connects and wakes.
Confirm same-origin browser requests always send a matching `Origin`.
