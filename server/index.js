const http = require("http");
const fs = require("fs");
const path = require("path");
const dgram = require("dgram");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const { renderLayout } = require("./tools");
const createToolTabs = require("./tool-tabs");
const webProxy = require("./web-proxy");
const recover = require("./recover");
const maint = require("./maint");

const PORT = process.env.PORT || 7681;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const ZELLIJ_CONFIG_DIR = process.env.ZELLIJ_CONFIG_DIR || "/app/zellij";

// Zellij owns terminal persistence; the bridge restores missing tools and
// selects them by name so closed/reordered tabs cannot break the toolbar.
const ZELLIJ_SESSION = process.env.ZELLIJ_SESSION || "nexus";
const toolTabs = createToolTabs(ZELLIJ_SESSION);
fs.writeFileSync(path.join(ZELLIJ_CONFIG_DIR, "layouts", "nexus.kdl"), renderLayout());

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

// Image drop-box: pasted/dropped screenshots land here (bind-mounted from
// /mnt/user/appdata/claude-helper/inbox on the host, so both the claude tab
// -- via /host/... -- and plain host shells can read them). Filenames are
// generated server-side; the client never controls the path.
const INBOX_DIR = process.env.INBOX_DIR || "/app/inbox";
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function handleUpload(req, res) {
  const ext = IMAGE_EXT[(req.headers["content-type"] || "").split(";")[0].trim()];
  if (!ext) {
    res.writeHead(415, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "only png/jpeg/gif/webp accepted" }));
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > UPLOAD_MAX_BYTES) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "too large" }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
    const name = `paste-${stamp}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    fs.writeFile(path.join(INBOX_DIR, name), Buffer.concat(chunks), (err) => {
      if (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, file: name }));
    });
  });
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
  if (req.url === "/api/upload" && req.method === "POST") {
    handleUpload(req, res);
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
  if (req.url === "/api/recover" && req.method === "POST") {
    recover.handle(req, res, toolTabs);
    return;
  }
  if (req.url.startsWith("/api/maint/") && maint.handle(req, res)) return;
  if (webProxy.handleRequest(req, res)) return;
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
  let term;
  try {
    term = pty.spawn("zellij", ["attach", "-c", "-f", ZELLIJ_SESSION], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || "/root",
      env: { ...process.env, SHELL: process.env.SHELL || "/bin/bash", ZELLIJ_CONFIG_DIR },
    });
  } catch (err) {
    console.error("Nexus terminal attach failed:", err.message);
    ws.close(1011, "Terminal unavailable; reconnecting");
    return;
  }

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
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  function sendControl(message) {
    if (ws.readyState === ws.OPEN) ws.send("\x00" + JSON.stringify(message));
  }
  async function restoreTools(attempt) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      const name = await toolTabs.restore();
      readyResolve(true);
      sendControl({ type: "activeTab", name });
    } catch (err) {
      if (attempt < 7) {
        setTimeout(() => restoreTools(attempt + 1), Math.min(1000, 200 * (attempt + 1)));
      } else {
        console.error("Nexus tool recovery failed:", err.message);
        readyResolve(false);
        sendControl({ type: "toolError", message: "Tool recovery failed; reconnecting" });
        ws.close(1011, "Tool recovery failed");
      }
    }
  }
  term.onData(() => {
    if (!activeTabQueryStarted) {
      activeTabQueryStarted = true;
      restoreTools(0);
    }
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString();
      if (text.startsWith("\x00")) {
        try {
          const msg = JSON.parse(text.slice(1));
          // App-level liveness probe: the client pings on an interval and on
          // wake/network change, and reconnects if no reply arrives. Browsers
          // can't see protocol-level pings, and a half-open socket after sleep
          // otherwise looks alive while keystrokes go nowhere.
          if (msg.type === "ping") sendControl({ type: "pong" });
          if (msg.type === "resize") term.resize(msg.cols, msg.rows);
          if (msg.type === "selectTool") {
            ready.then(async (ok) => {
              if (!ok || ws.readyState !== ws.OPEN) return;
              try {
                const name = await toolTabs.select(msg.name);
                sendControl({ type: "activeTab", name });
              } catch (err) {
                console.error("Nexus tool selection failed:", err.message);
                sendControl({ type: "toolError", message: "Tool unavailable; select it to retry" });
              }
            });
          }
        } catch (_) {}
        return;
      }
      term.write(text);
      return;
    }
    term.write(data.toString());
  });

  ws.on("close", () => {
    readyResolve(false);
    try {
      term.kill();
    } catch (_) {}
  });
});

server.on("upgrade", (req, socket, head) => {
  if (webProxy.handleUpgrade(req, socket, head)) return;
  if (!req.url || !req.url.startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => console.log(`nexus terminal (zellij) listening on :${PORT}`));
