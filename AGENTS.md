# Nexus maintenance

Nexus is critical remote access for the owner. Its views, in three pills:
Claude Terminal + Claude.ai Web, Codex Terminal + ChatGPT Web, and Unraid
(host shell) + BankBreak + OpenCode. Terminal tabs are Zellij tabs; the two
Web tabs are remote Chromium containers proxied under /web/<name>/.
Preserve their availability and keep failures isolated to the affected tool.

- Tool commands and addresses are defined in `server/tools.js`. The default
  Zellij layout is generated from it; do not edit generated layout targets.
- Select tools by name. Missing tabs must be recoverable without resetting the
  session. SSH/docker-exec launchers retry disconnected tools.
- `server/supervise.js` supervises the web bridge independently of Zellij.
  Keep terminal sessions alive during web-bridge recovery.
- Validate named selection, deleted-tab recovery, reconnect recovery, and web
  process crash/hang recovery in a test instance before deploying such changes.
- The host OpenCode launcher terminates other OpenCode instances. A test that
  launches real OpenCode can interrupt a production OpenCode session; avoid
  concurrent real-tool tests while the owner is using it.
- Keep a source backup and a tagged previous image before deployment. Preserve
  the existing SSH key mounts, Docker socket, inbox, port, and Authentik routing.
- BankBreak is 192.168.1.176. The web tabs are the claude-browser (:3020) and
  chatgpt-browser (:3021) containers, served through server/web-proxy.js so the
  nexus login covers them (their own hostnames are frame-busted by their logins).
  Verify them when changing dependent services.
- Recovery and maintenance: server/recover.js (configure -> Recover buttons) and
  server/maint.js + maint-scan.js (Maintenance panel). The scanner runs in a
  throwaway `--pid=host --privileged --cgroupns=host` container; only orphaned
  tool sessions are ever killable, and it must never kill nexus or anything
  still attached -- keep it fail-safe (unknown = protected).
- supervise.js deletes the serialized Zellij session at container start;
  Zellij 0.44 otherwise resurrects every tab as a bare shell after a restart.
- The claude tool tags its process (NEXUS_TOOL=claude) and reaps the previous
  tagged `claude` on launch; a docker exec session outlives its client.
- Test instance: `docker run --name nexus-test --network host -e PORT=17681
  -e ZELLIJ_SESSION=nexustest` with read-only mounts of changed files from a
  host path and a STUB tools.js (an `sh` read loop -- not `bash -l`, and never
  real opencode). Mounting public/ hides the image's vendor/ -- copy it in.
- Server-only changes deploy without a rebuild: `docker cp` the file, then kill
  only the `node /app/server/index.js` process; supervise.js restarts it and
  Zellij keeps every session. public/* only needs a page reload.
- Do not claim absolute uptime: Unraid, networking, Cloudflare, and Authentik
  remain dependencies. Handle maintenance in the scope already authorized by
  the user and avoid unnecessary interruptions or repeated permission requests.
