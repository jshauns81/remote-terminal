// Recovery actions behind the configure menu's "Recover" buttons. Each one
// fixes a single stuck piece without touching the others:
//   tool    -- restart one terminal tab's connection (ssh / docker exec)
//   browser -- restart one web tab's Chromium container
//   bridge  -- restart this web bridge (Zellij and its tabs keep running)
const fs = require("fs");
const { execFile } = require("child_process");
const { names, reapTagged } = require("./tools");

const BROWSERS = { claudeai: "claude-browser", chatgpt: "chatgpt-browser" };

function processes() {
  const out = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ").trim();
      const ppid = Number(fs.readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1].split(" ")[1]);
      out.push({ pid: Number(entry), ppid, cmd });
    } catch (_) {} // process exited mid-scan
  }
  return out;
}

function killTree(pid, all) {
  for (const child of all.filter((p) => p.ppid === pid)) killTree(child.pid, all);
  try { process.kill(pid, "SIGTERM"); } catch (_) {}
  setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch (_) {} }, 3000).unref();
}

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout));
  });
}

async function restartTool(name, toolTabs) {
  if (!names.includes(name)) throw new Error("Unknown tool");
  const all = processes();
  const launcher = all.find((p) => p.cmd === `node /app/server/launch-tool.js ${name}`);
  if (!launcher) {
    // The whole tab is gone: recreate it from tools.js.
    await toolTabs.select(name);
    return "tab recreated";
  }
  // `docker exec` sessions outlive their client, so also stop the old shell
  // inside the target container (tagged NEXUS_TOOL=<name> by tools.js) --
  // otherwise every restart would leave an orphaned Claude Code running.
  if (name === "claude") {
    await run("docker", ["exec", "claude-helper", "bash", "-c", reapTagged("claude")], 10000).catch(() => {});
  }
  // Killing the launcher's children (not the launcher) makes it reconnect in
  // ~5 s, in the same Zellij pane.
  for (const child of all.filter((p) => p.ppid === launcher.pid)) killTree(child.pid, all);
  return "reconnecting";
}

async function restartBrowser(name) {
  const container = BROWSERS[name];
  if (!container) throw new Error("Unknown browser");
  await run("docker", ["restart", "-t", "10", container], 60000);
  return "restarted";
}

// POST /api/recover {action, name}. The custom header can't be sent
// cross-origin without a CORS preflight this server never answers, so another
// site can't trigger these through the user's logged-in browser.
function handle(req, res, toolTabs) {
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.headers["x-nexus-recover"] !== "1") return reply(403, { ok: false, error: "missing header" });
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on("end", async () => {
    let msg;
    try { msg = JSON.parse(body); } catch (_) { return reply(400, { ok: false, error: "bad json" }); }
    try {
      if (msg.action === "tool") return reply(200, { ok: true, result: await restartTool(msg.name, toolTabs) });
      if (msg.action === "browser") return reply(200, { ok: true, result: await restartBrowser(msg.name) });
      if (msg.action === "bridge") {
        reply(200, { ok: true, result: "restarting" });
        console.error("Web bridge restart requested from the Recover menu");
        // supervise.js restarts the bridge; Zellij and its tabs keep running.
        setTimeout(() => process.exit(0), 300);
        return;
      }
      reply(400, { ok: false, error: "unknown action" });
    } catch (err) {
      reply(500, { ok: false, error: err.message });
    }
  });
}

module.exports = { handle };
