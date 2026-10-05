// Keep Zellij and SSH sessions alive when only the web bridge needs recovery.
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
let child, restarting = false, stopping = false, failures = 0, probeRunning = false;

// This process is PID 1, so it starts only when the container starts -- when no
// Zellij server can be alive. A container *restart* (host reboot, docker
// restart) still leaves the previous session serialized on disk, and attaching
// "resurrects" it with every tab as a bare shell instead of its tool (seen
// with Zellij 0.44 even with `attach -f`). Delete it so the first attach builds
// a fresh session from the tool layout.
try {
  require("child_process").execFileSync("zellij",
    ["delete-session", process.env.ZELLIJ_SESSION || "nexus"],
    { stdio: "ignore", timeout: 10000 });
  console.error("Cleared stale Zellij session from the previous container run");
} catch (_) {} // nothing to clear

function start() {
  if (stopping) return;
  restarting = false;
  failures = 0;
  child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    stdio: "inherit", env: { ...process.env, SHELL: process.env.SHELL || "/bin/bash" },
  });
  child.on("error", (err) => console.error("Nexus web bridge:", err.message));
  child.once("close", (code, signal) => {
    if (stopping) return;
    console.error(`Nexus web bridge stopped (${code ?? signal}); restarting in 2 seconds`);
    setTimeout(start, 2000);
  });
}
function restartWeb() {
  if (restarting || stopping || !child || child.exitCode !== null) return;
  restarting = true;
  console.error("Nexus web bridge failed three health checks; restarting the web bridge");
  const old = child;
  old.kill("SIGTERM");
  const force = setTimeout(() => {
    if (old.exitCode === null && old.signalCode === null) old.kill("SIGKILL");
  }, 5000);
  force.unref();
}
const monitor = setInterval(() => {
  if (stopping || restarting || probeRunning) return;
  probeRunning = true;
  let settled = false;
  function finish(ok) {
    if (settled) return;
    settled = true;
    probeRunning = false;
    failures = ok ? 0 : failures + 1;
    if (failures >= 3) restartWeb();
  }
  const req = http.get({ hostname: "127.0.0.1", port: process.env.PORT || 7681,
    path: "/healthz", timeout: 4000 }, (res) => {
    res.resume();
    finish(res.statusCode === 200);
  });
  req.on("timeout", () => req.destroy(new Error("health check timed out")));
  req.on("error", () => finish(false));
}, 15000);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(monitor);
    if (child) child.kill(signal);
    setTimeout(() => process.exit(0), 1000);
  });
}
start();
