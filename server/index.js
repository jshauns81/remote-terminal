const http = require("http");
const fs = require("fs");
const path = require("path");
const dgram = require("dgram");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");

const PORT = process.env.PORT || 7681;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const ZELLIJ_CONFIG_DIR = process.env.ZELLIJ_CONFIG_DIR || "/app/zellij";

// The terminal experience is now a single persistent Zellij session. This node
// layer is a dumb pipe: it serves the static SPA and bridges each websocket to
// one `zellij attach` pty. Zellij owns multiplexing, panes, tabs, scrollback,
// session persistence, resize and DA — so there is no ring buffer, no token,
// no per-tab dispatch, no session bookkeeping here anymore.
const ZELLIJ_SESSION = process.env.ZELLIJ_SESSION || "nexus";

// The tab bar is static HTML that always starts with "claude" highlighted --
// on a hard refresh or an auto-reconnect, Zellij correctly repaints whatever
// tab was actually focused (session state persists server-side), but nothing
// told the browser which button that was, so the highlight stayed stuck on
// "claude" even when e.g. "host" was the real, visible tab (found + root-caused
// 2026-07-02). Fix: ask Zellij directly once the new pty attach is confirmed
// live, and forward the answer to the client as a control message; the client
// only updates the highlight from this, it never re-sends a tab-switch itself,
// so this can't cause an unwanted tab change.
//
// Uses `list-tabs --state` (not `current-tab-info`): the latter resolves
// against "the calling process's own client," and a one-shot `zellij action`
// invocation from outside is never itself an attached client, so it always
// errors "No active tab found for current client" even while a real browser
// IS attached and focused (verified live, 2026-07-02). `list-tabs -s` reports
// session-wide state instead, correctly showing which tab the real attached
// client(s) have focused.
function getActiveTabName() {
  return new Promise((resolve) => {
    execFile("zellij", ["--session", ZELLIJ_SESSION, "action", "list-tabs", "-s", "-j"], (err, stdout) => {
      if (err) { resolve(null); return; }
      try {
        const tabs = JSON.parse(stdout);
        const active = tabs.find((t) => t.active);
        resolve(active ? active.name : null);
      } catch (_) { resolve(null); }
    });
  });
}

// Wake-on-LAN for the "llm" tab's target desktop. Sent to a dedicated, unused
// IP (192.168.1.100) that the gateway has a static ARP entry for pointing at
// the broadcast MAC (ff:ff:ff:ff:ff:ff) -- that turns this ordinary routed
// unicast UDP packet into an L2 broadcast frame on the target's VLAN, which
// is required for WoL to reach a sleeping host (it won't answer ARP itself).
const WOL_MAC = process.env.WOL_MAC || "10:ff:e0:b9:c0:55";
const WOL_IP = process.env.WOL_IP || "192.168.1.100";
const WOL_PORT = Number(process.env.WOL_PORT || 9);

function buildMagicPacket(mac) {
  const macBytes = mac.split(":").map((b) => parseInt(b, 16));
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) Buffer.from(macBytes).copy(packet, 6 + i * 6);
  return packet;
}

function sendWakePacket() {
  const packet = buildMagicPacket(WOL_MAC);
  const socket = dgram.createSocket("udp4");
  // Fire a few times -- WoL is fire-and-forget UDP, no delivery confirmation.
  let sent = 0;
  const send = () => {
    socket.send(packet, WOL_PORT, WOL_IP, () => {
      sent += 1;
      if (sent >= 3) socket.close();
    });
  };
  send();
  setTimeout(send, 150);
  setTimeout(send, 300);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.url === "/api/wake" && req.method === "POST") {
    try {
      sendWakePacket();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }
  const reqPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(PUBLIC_DIR, path.normalize(reqPath).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true });

// Keepalive: Cloudflare's edge reaps a WebSocket that goes idle (no frames) for
// ~156s. Ping every socket well under that; browsers auto-reply PONG and we cut
// dead peers. (Root-caused + verified previously.)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);
heartbeat.unref();
wss.on("close", () => clearInterval(heartbeat));

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // `attach -c` creates the session on first connect (using default_layout
  // "nexus" from the zellij config) and attaches thereafter. The session
  // persists across disconnects, so a reconnect just re-attaches and Zellij
  // repaints current state — no replay logic needed on our side.
  //
  // `-f` is required for the case where the zellij *server* process died
  // (container restart) but its session state file didn't (survives under
  // /tmp across a restart of the same container). Without `-f`, `attach -c`
  // silently "resurrects" that dead session using the old layout but does
  // NOT re-run any pane commands -- every pane comes back as a bare /bin/sh
  // with no content, no error, indistinguishable from a healthy empty shell
  // until you actually look inside it. `-f` forces pane commands to run
  // again on resurrection, matching genuinely-fresh-session behavior.
  const term = pty.spawn("zellij", ["attach", "-c", "-f", ZELLIJ_SESSION], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME || "/root",
    env: { ...process.env, ZELLIJ_CONFIG_DIR },
  });

  term.onData((d) => {
    if (ws.readyState === ws.OPEN) ws.send(d);
  });
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  // Querying immediately on connect races the attach handshake -- the pty
  // process exists but Zellij's server hasn't registered it as a client yet,
  // so `list-tabs -s` reports no active tab at all (verified live). First
  // pty data confirms the attach actually completed; a short retry chain
  // covers any remaining lag between that and the server-side registration.
  let activeTabQueryStarted = false;
  function trySendActiveTab(attempt) {
    if (ws.readyState !== ws.OPEN) return;
    getActiveTabName().then((name) => {
      if (ws.readyState !== ws.OPEN) return;
      if (name) {
        ws.send("\x00" + JSON.stringify({ type: "activeTab", name }));
      } else if (attempt < 4) {
        setTimeout(() => trySendActiveTab(attempt + 1), 200 * (attempt + 1));
      }
    });
  }
  term.onData(() => {
    if (!activeTabQueryStarted) {
      activeTabQueryStarted = true;
      trySendActiveTab(0);
    }
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString();
      if (text.startsWith("\x00")) {
        try {
          const msg = JSON.parse(text.slice(1));
          if (msg.type === "resize") term.resize(msg.cols, msg.rows);
        } catch (_) {}
        return;
      }
      term.write(text);
      return;
    }
    term.write(data.toString());
  });

  ws.on("close", () => {
    try {
      term.kill();
    } catch (_) {}
  });
});

server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => console.log(`nexus terminal (zellij) listening on :${PORT}`));
