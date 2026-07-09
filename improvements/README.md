# nexus — improvement plan

Incremental improvements for the nexus web terminal. **No redesign, no refactor** —
each item is self-contained and preserves the current architecture (Node dumb-pipe →
`zellij attach` pty; xterm.js SPA on top; Zellij owns multiplexing/persistence/
scrollback/resize).

## How this folder is organized

Items are split into three tiers by value-to-effort. Each tier file lists items with:
a **What/Why**, the exact **files** to touch, an **implementation sketch**, and a
**verification** step.

- [`tier-1-high-value.md`](./tier-1-high-value.md) — WebGL renderer, lockfile,
  PWA/manifest, Origin check. Highest leverage, each essentially self-contained.
- [`tier-2-quality.md`](./tier-2-quality.md) — tab-state desync, paste/ctrl coverage,
  HEALTHCHECK + graceful shutdown, static-asset caching.
- [`tier-3-nice-to-have.md`](./tier-3-nice-to-have.md) — bundled mono font, manual
  reconnect, path hardening, pty spawn error handling.

## Split of labor (important)

These specs were authored in a remote environment that **cannot build the image, run
Zellij, reach the real hosts, or open a browser**. So they are unverified against
runtime. Two categories:

- **Infra-independent** (WebGL, lockfile, PWA, Origin check, caching, HEALTHCHECK,
  font, reconnect, path hardening, spawn guard): safe to implement from these specs;
  verify in a real browser / built image.
- **Infra-coupled** (tab-state desync needs a live Zellij; paste needs a real phone;
  anything touching the real hosts): implement **on the server** where they can
  actually be exercised.

## Suggested order

1. Tier 1 in full (do WebGL first — biggest perceived-speed win).
2. Tier 2 items 7–8 (HEALTHCHECK, caching) — trivial and safe.
3. Tier 2 items 5–6 (tab desync, paste) — verify against live Zellij / a phone.
4. Tier 3 as time allows.

## Progress checklist

- [ ] T1.1 WebGL renderer with canvas fallback
- [ ] T1.2 Commit `package-lock.json`, switch to `npm ci`
- [ ] T1.3 PWA manifest + icons + apple meta + favicon
- [ ] T1.4 Origin allowlist on WS upgrade and `/api/wake`
- [ ] T2.5 Tab-state desync (client bar reflects real Zellij tab)
- [ ] T2.6 Paste affordance + wider ctrl-combo coverage
- [ ] T2.7 Docker `HEALTHCHECK` + `SIGTERM` graceful shutdown
- [ ] T2.8 `immutable` caching for `/vendor/*`, keep `no-store` for HTML
- [ ] T3.9 Bundle a mono webfont (e.g. JetBrains Mono)
- [ ] T3.10 Manual "reconnect now" on the status pill
- [ ] T3.11 Verify resolved static path stays within `PUBLIC_DIR`
- [ ] T3.12 `pty.spawn` try/catch closing the socket cleanly
