// Selkies' sidebar Apps panel loads the proot-apps catalog (metadata.yml and
// its icons) straight from raw.githubusercontent.com in the viewer's own
// browser. On a network that blocks GitHub (Shaun's corp network) the panel
// just says "Failed to load app data". Fix, all under nexus's own origin:
//   - the Selkies dashboard bundle is served with that GitHub URL swapped for
//     the relative "proot-meta/", so it resolves to /web/<name>/proot-meta/;
//   - those files are fetched from GitHub here, server side.
const https = require("https");

const ORIGIN = "https://raw.githubusercontent.com/linuxserver/proot-apps/master/metadata/";
const LOCAL = "proot-meta/";
const META_PATH = /^\/proot-meta\/((?:img\/)?[A-Za-z0-9][A-Za-z0-9._-]*)$/;
const BUNDLE_PATH = /^\/assets\/index-[A-Za-z0-9_-]+\.js$/;
const FETCH_TIMEOUT_MS = 10000;
const CACHE_SECONDS = 3600;

const pathOnly = (p) => p.split("?")[0];

function isBundle(path) {
  return BUNDLE_PATH.test(pathOnly(path));
}

// Serves /proot-meta/<file> from GitHub. Returns false for any other path.
function serve(path, res) {
  const m = META_PATH.exec(pathOnly(path));
  if (!m) return false;
  const up = https.get(ORIGIN + m[1], { timeout: FETCH_TIMEOUT_MS }, (gh) => {
    // Third-party files (SVG icons included) on nexus's own origin: never let
    // one run script if it's opened as a page rather than an <img>.
    const headers = {
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    };
    if (gh.headers["content-type"]) headers["content-type"] = gh.headers["content-type"];
    if (gh.headers["content-length"]) headers["content-length"] = gh.headers["content-length"];
    res.writeHead(gh.statusCode, headers);
    gh.pipe(res);
  });
  up.on("timeout", () => up.destroy(new Error("timed out")));
  up.on("error", (err) => {
    console.error("[proot-meta] GitHub fetch failed:", m[1], err.message);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("proot-apps catalog unavailable");
  });
  res.on("close", () => { if (!res.writableFinished) up.destroy(); });
  return true;
}

// Request headers for fetching the bundle: uncompressed (so it can be
// rewritten) and unconditional (a 304 would keep a cached, unrewritten copy).
function bundleRequestHeaders(headers) {
  const out = { ...headers, "accept-encoding": "identity" };
  delete out["if-none-match"];
  delete out["if-modified-since"];
  return out;
}

// Buffers the upstream bundle and sends it with the GitHub URL made local.
function sendRewritten(up, res) {
  const chunks = [];
  up.on("data", (c) => chunks.push(c));
  up.on("error", () => res.destroy());
  up.on("end", () => {
    const body = Buffer.from(Buffer.concat(chunks).toString("utf8").split(ORIGIN).join(LOCAL), "utf8");
    const headers = { ...up.headers, "content-length": body.length, "cache-control": "no-cache" };
    for (const h of ["etag", "last-modified", "content-encoding", "transfer-encoding"]) delete headers[h];
    res.writeHead(200, headers);
    res.end(body);
  });
}

module.exports = { isBundle, serve, bundleRequestHeaders, sendRewritten };
