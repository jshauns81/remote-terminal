const { spawn } = require("child_process");
const name = process.argv[2];
if (!Object.hasOwn(require("./tools").tools, name)) throw new Error("Unknown Nexus tool");
let child, timer, stopping = false;

// Re-read tools.js on every (re)launch so an edited tool command applies on
// the next reconnect, without recreating the container. Falls back to the
// last good definition if the file is mid-edit or broken.
let tool = require("./tools").tools[name];
function current() {
  try {
    delete require.cache[require.resolve("./tools")];
    tool = require("./tools").tools[name] || tool;
  } catch (err) {
    console.error(`${name}: keeping previous tool definition (${err.message})`);
  }
  return tool;
}

function launch() {
  if (stopping) return;
  const t = current();
  console.log(`\r\n${t.openMessage || `Opening ${name}…`}`);
  child = spawn(t.command, t.args, { stdio: "inherit" });
  child.on("error", (err) => console.error(`${name}: ${err.message}`));
  child.once("close", () => {
    if (stopping) return;
    console.log(`\r\n${name} disconnected. Retrying in 5 seconds…`);
    timer = setTimeout(launch, 5000);
  });
}
// Zellij builds a new session at the 80x24 placeholder size whenever the
// first attach comes from a client that never reports its size (e.g. the
// rebuild health check). A TUI started then (Claude, Codex, OpenCode) draws
// at 80 columns, and when the real browser resizes the pane Zellij rewraps
// that narrow output into a garbled double column. So the first launch waits
// until something has given the pane a real size.
function whenSized(start) {
  const out = process.stdout;
  const size = () => (out.isTTY && out.getWindowSize ? out.getWindowSize() : [0, 0]);
  if (!out.isTTY || size().join("x") !== "80x24") return start();
  console.log(`\r\n${name}: waiting for a browser to size the terminal…`);
  // Poll the live window size: an event listener alone doesn't keep Node
  // running, so the launcher would simply exit while "waiting".
  const poll = setInterval(() => {
    if (size().join("x") === "80x24") return;
    clearInterval(poll);
    process.stdout.write("\x1b[2J\x1b[H");
    start();
  }, 500);
}

// Ctrl+C belongs to the foreground application, not its recovery wrapper.
process.on("SIGINT", () => {});
for (const signal of ["SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopping = true;
    clearTimeout(timer);
    if (child && child.exitCode === null) child.kill(signal);
    process.exit(0);
  });
}
whenSized(launch);
