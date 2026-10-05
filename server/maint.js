// Maintenance panel backend: GET /api/maint/scan, POST /api/maint/kill.
// The actual inspection and killing happen in server/maint-scan.js, run in a
// throwaway container with the host pid namespace (it has to see -- and be
// able to signal -- processes in every container). This server only feeds it
// the container map and relays the JSON. All protection rules (never nexus,
// never anything still attached, re-check pid+start before killing) live in
// the scanner, so they apply no matter what the browser sends.
const { execFile } = require("child_process");

const IMAGE = process.env.MAINT_IMAGE || "remote-terminal-remote-terminal:latest";
// Host path of the scanner (bind-mounted read-only into the throwaway container).
const SCRIPT = process.env.MAINT_SCRIPT_HOST || "/mnt/user/appdata/remote-terminal/server/maint-scan.js";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err && !stdout ? reject(new Error((stderr || err.message).trim())) : resolve(stdout));
  });
}

async function context() {
  const ids = (await run("docker", ["ps", "-q"])).split("\n").filter(Boolean);
  const lines = (await run("docker", ["inspect", "--format", "{{.Id}}|{{.Name}}|{{.State.Pid}}", ...ids]))
    .split("\n").filter(Boolean);
  const containers = {};
  for (const l of lines) {
    const [id, name, pid] = l.split("|");
    containers[id] = { name: name.replace(/^\//, ""), initPid: Number(pid) };
  }
  return { nexusContainer: "remote-terminal", containers };
}

// One scanner run at a time; a scan request arriving mid-run shares its result.
let inflight = null;
async function scanner(mode, arg) {
  const ctx = await context();
  const args = ["run", "--rm", "--pid=host", "--privileged", "--cgroupns=host", "--network", "none",
    "--log-driver", "none", "--read-only", "-e", `MAINT_CTX=${JSON.stringify(ctx)}`,
    "-v", `${SCRIPT}:/maint-scan.js:ro`, "--entrypoint", "node", IMAGE, "/maint-scan.js", mode];
  if (arg) args.push(arg);
  const out = JSON.parse(await run("docker", args, { timeout: mode === "kill" ? 60000 : 30000 }));
  if (out.error) throw new Error(out.error);
  return out;
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function handle(req, res) {
  if (req.url === "/api/maint/scan" && req.method === "GET") {
    if (!inflight) inflight = scanner("scan").finally(() => { inflight = null; });
    inflight.then((r) => reply(res, 200, { ok: true, ...r }), (e) => reply(res, 500, { ok: false, error: e.message }));
    return true;
  }
  if (req.url === "/api/maint/kill" && req.method === "POST") {
    // Same CSRF guard as /api/recover: a custom header forces a CORS preflight
    // this server never answers, so other sites can't trigger kills.
    if (req.headers["x-nexus-recover"] !== "1") { reply(res, 403, { ok: false, error: "missing header" }); return true; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on("end", async () => {
      let targets;
      try {
        targets = JSON.parse(body).targets;
        if (!Array.isArray(targets) || !targets.every((t) => Number.isInteger(t.pid) && Number.isInteger(t.start))) throw 0;
      } catch (_) { return reply(res, 400, { ok: false, error: "targets must be [{pid,start}]" }); }
      try { reply(res, 200, { ok: true, ...(await scanner("kill", JSON.stringify(targets))) }); }
      catch (e) { reply(res, 500, { ok: false, error: e.message }); }
    });
    return true;
  }
  return false;
}

module.exports = { handle };
