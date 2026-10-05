// One source of truth for initial tabs and recovery of a missing tab.
const sshOptions = [
  "-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
];
const hostSsh = [...sshOptions, "-i", "/app/ssh-keys/id_ed25519",
  "-o", "UserKnownHostsFile=/tmp/known_hosts", "root@192.168.10.2"];
// Shell snippet (run inside the target container) that SIGTERMs processes
// whose command is \`<cmd>\` and whose environment carries NEXUS_TOOL=<cmd>,
// skipping the shell running it.
function reapTagged(cmd) {
  return [
    "for p in /proc/[0-9]*; do",
    '  q=${p#/proc/}; [ "$q" = "$$" ] && continue',
    `  case "$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null)" in`,
    `    ${cmd}|"${cmd} "*) tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx NEXUS_TOOL=${cmd} && kill -TERM "$q" ;;`,
    "  esac",
    "done 2>/dev/null",
  ].join("\n");
}

// Every (re)launch -- reconnect, rebuild, Recover -> Restart tab -- picks the
// last conversation back up. --continue only when this directory has one;
// otherwise it would exit with "no conversation" and leave a bare shell.
const resumeClaude = 'if ls ~/.claude/projects/"$(pwd | sed "s#[/.]#-#g")"/*.jsonl >/dev/null 2>&1; ' +
  'then claude --continue; else claude; fi';

const tools = {
  // A docker exec session keeps running after its client dies, so every
  // nexus reconnect/rebuild used to leave the previous Claude Code running in
  // claude-helper (30 of them, ~11 GB, found 2026-10-05). NEXUS_TOOL tags the
  // tab's Claude, and each launch first stops the previous tagged one --
  // matched on the claude command itself, so detached jobs started from the
  // tab (which inherit the tag) are never touched.
  // TERM/COLORTERM: docker exec defaults to plain TERM=xterm, which made
  // Claude Code render in 16 colours (every theme colour rounded to the
  // nearest basic one -- the near-black selection). The nexus terminal is
  // 24-bit, so say so.
  claude: { command: "docker", args: ["exec", "-it", "-e", "NEXUS_TOOL=claude",
    "-e", "TERM=xterm-256color", "-e", "COLORTERM=truecolor", "claude-helper", "bash", "-lc",
    `${reapTagged("claude")}\n${resumeClaude}; exec bash -l`] },
  host: { command: "ssh", args: hostSsh },
  opencode: { command: "ssh", args: [...hostSsh, "opencode"] },
  // Native Codex on the host (/usr/local/bin/codex, state in appdata/codex-native),
  // started by the forced-command dispatcher like opencode. -a never: no
  // approval prompts (that's the whole ask). --sandbox workspace-write, not
  // --dangerously-bypass-approvals-and-sandbox: commands still run inside
  // Codex's own sandbox instead of raw on the Unraid host as root -- the
  // 2026-10-05 emhttpd incident happened at exactly the escalated-permission
  // step this keeps in place. Revisit only with Shaun's explicit say-so.
  codex: { command: "ssh", args: [...hostSsh, "codex", "-a", "never", "--sandbox", "workspace-write"] },
  llm: { command: "ssh", args: [...sshOptions, "-i", "/app/ssh-keys/id_ed25519_llm",
    "-o", "UserKnownHostsFile=/tmp/known_hosts_llm", "jshau@192.168.1.176"] },
};
const names = Object.keys(tools);

function renderLayout(selected = names) {
  for (const name of selected) {
    if (!Object.hasOwn(tools, name)) throw new Error("Unknown Nexus tool");
  }
  return `// Generated from server/tools.js. Edit tool targets there.\nlayout {\n` +
    `    default_tab_template { children; }\n` +
    selected.map((name) => `    tab name=${JSON.stringify(name)} {\n` +
      `        pane command="node" {\n` +
      `            args "/app/server/launch-tool.js" ${JSON.stringify(name)};\n` +
      `            close_on_exit false\n        }\n    }\n`).join("") + `}\n`;
}
module.exports = { tools, names, renderLayout, reapTagged };
