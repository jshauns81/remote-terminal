// Reverse proxy for the web tabs (claude.ai / chatgpt remote browsers).
//
// The browsers used to be iframed from their own hostnames, each behind its
// own login. Both logins (Cloudflare Access, then Authentik) refuse to render
// inside a frame (X-Frame-Options: DENY), so whenever that second session was
// missing or expired the tab went blank. Serving them under nexus's own origin
// (/web/<name>/) puts them behind the nexus login the page already passed --
// no second auth hop, nothing frame-busted. Selkies derives its asset and
// websocket URLs from the page path, so it runs fine under a subpath.
const http = require("http");
const net = require("net");

const TARGET_HOST = process.env.WEB_TARGET_HOST || "192.168.10.2";
const TARGETS = {
  claudeai: Number(process.env.CLAUDEAI_PORT || 3020),
  chatgpt: Number(process.env.CHATGPT_PORT || 3021),
};
const PREFIX = /^\/web\/([a-z]+)(\/.*)?$/;
const CONNECT_TIMEOUT_MS = 5000;
// Keepalive probes notice a vanished peer (container restart, host network
// blip) instead of leaving a dead stream socket pinned open forever.
const KEEPALIVE_MS = 15000;

// Shown in the iframe when a browser container is down. It retries on its own,
// so the tab heals itself once the container is back -- no manual reload.
function unavailablePage(name, detail) {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>${name} unavailable</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#161a1d;color:#c9d1d9;font:15px system-ui,sans-serif;text-align:center">
<div><p style="font-size:17px;margin:0 0 8px">The ${name} browser isn't responding.</p>
<p style="margin:0;opacity:.7">Retrying every 5 seconds\u2026 (${detail.replace(/[<&]/g, "")})</p></div>`;
}

// Returns { port, path } for /web/<name>/..., or null if not a web-tab URL.
function match(url) {
  const m = PREFIX.exec(url || "");
  if (!m || !TARGETS[m[1]]) return null;
  return { name: m[1], port: TARGETS[m[1]], path: m[2] || "/" };
}

function handleRequest(req, res) {
  const t = match(req.url);
  if (!t) return false;
  // /web/claudeai -> /web/claudeai/ so relative asset URLs resolve under it.
  if (!/^\/web\/[a-z]+\//.test(req.url)) {
    res.writeHead(301, { location: `/web/${t.name}/` });
    res.end();
    return true;
  }
  const upstream = http.request({
    host: TARGET_HOST, port: t.port, method: req.method, path: t.path,
    headers: { ...req.headers, host: `${TARGET_HOST}:${t.port}` },
    timeout: CONNECT_TIMEOUT_MS,
  }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("timed out")));
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(unavailablePage(t.name, err.message));
    } else {
      res.destroy();
    }
  });
  // Client went away mid-request: don't leave the upstream request hanging.
  res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
  return true;
}

// Websocket upgrade: replay the request line + headers to the target and then
// splice the two sockets together.
function handleUpgrade(req, socket, head) {
  const t = match(req.url);
  if (!t) return false;
  const up = net.connect({ port: t.port, host: TARGET_HOST, timeout: CONNECT_TIMEOUT_MS }, () => {
    up.setTimeout(0); // connected; the stream itself may idle legitimately
    up.setKeepAlive(true, KEEPALIVE_MS);
    socket.setKeepAlive(true, KEEPALIVE_MS);
    const headers = { ...req.headers, host: `${TARGET_HOST}:${t.port}` };
    let raw = `${req.method} ${t.path} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const val of Array.isArray(v) ? v : [v]) raw += `${k}: ${val}\r\n`;
    }
    up.write(raw + "\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  let connected = false;
  up.once("connect", () => { connected = true; });
  up.on("timeout", () => up.destroy(new Error("timed out")));
  const close = () => { up.destroy(); socket.destroy(); };
  up.on("error", () => {
    // Upstream never answered: give the client a real HTTP error so Selkies
    // sees a failed handshake and retries, instead of a silent reset. end()
    // lets the 502 flush before the client socket closes.
    if (!connected) {
      up.destroy();
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      else socket.destroy();
      return;
    }
    close();
  });
  socket.on("error", close);
  up.on("close", () => { if (connected) socket.destroy(); });
  socket.on("close", () => up.destroy());
  return true;
}

module.exports = { handleRequest, handleUpgrade };
