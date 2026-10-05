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
  console.log(`\r\nOpening ${name}…`);
  const t = current();
  child = spawn(t.command, t.args, { stdio: "inherit" });
  child.on("error", (err) => console.error(`${name}: ${err.message}`));
  child.once("close", () => {
    if (stopping) return;
    console.log(`\r\n${name} disconnected. Retrying in 5 seconds…`);
    timer = setTimeout(launch, 5000);
  });
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
launch();
