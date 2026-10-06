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
  // 2026-10-05: moved off the bare host (SSH + dispatcher) into its own
  // container, codex-terminal (appdata/codex-terminal) -- same recipe as
  // claude-helper (gh/gk/python3/uv, /host + docker.sock mounted, same
  // broad reach), with AGENTS.md as its CLAUDE.md equivalent. Needed
  // because bubblewrap (its sandbox mechanism) can't run at all on bare
  // Unraid: pivot_root fails, because Unraid's own root is RAM/tmpfs with
  // no backing block device, not a config problem. approval_policy=never +
  // sandbox_mode=danger-full-access live in its config.toml (shared with
  // the old host install at codex-native/home, bind-mounted into the
  // container) -- nothing to pass here.
  // No reapTagged() here, deliberately: unlike claude, `codex`'s binary is a
  // `#!/usr/bin/env node` script, so its process shows up as `node ...`, not
  // `codex`, and it spawns its own long-lived background service children
  // that inherit the same NEXUS_TOOL env tag -- a literal-match reaper would
  // either never fire or, loosened, risk killing those legitimate children.
  // The Maintenance panel already classifies codex sessions correctly
  // (orphan/attached/service); use it to clear stale codex-terminal
  // sessions instead of guessing a matcher here.
  //
  // 2026-10-06: drops into a shell instead of auto-launching codex, so a
  // session can be targeted at any project -- cd to it, then run `codex`
  // yourself. AGENTS.md only reliably loads for sessions started at /root
  // or under it: Codex's own AGENTS.md discovery walks up from cwd only as
  // far as the nearest project_root_marker (.git by default) and stops
  // there, confirmed by grepping a session's own rollout log for the
  // file's exact content when started from a project elsewhere (found:
  // none). So a session targeted outside /root runs with exactly the
  // access this container already has -- full host reach, no sandbox, no
  // approval prompts -- same as /root sessions, just without that extra
  // documented layer on top.
  codex: { command: "docker", args: ["exec", "-it", "-e", "NEXUS_TOOL=codex",
    "-e", "TERM=xterm-256color", "-e", "COLORTERM=truecolor", "codex-terminal", "bash", "-lc",
    "cd /host/mnt/user/developer 2>/dev/null; exec bash -l"],
    openMessage: "Shell in codex-terminal, cwd /mnt/user/developer. cd to a project, then run: codex" },
  // Same shape as codex. agy's safety rules are its global ~/.gemini/GEMINI.md
  // (mounted read-only by antigravity-terminal), so they load from any cwd.
  antigravity: { command: "docker", args: ["exec", "-it", "-e", "NEXUS_TOOL=antigravity",
    "-e", "TERM=xterm-256color", "-e", "COLORTERM=truecolor", "antigravity-terminal", "bash", "-lc",
    "cd /host/mnt/user/developer 2>/dev/null; exec bash -l"],
    openMessage: "Shell in antigravity-terminal, cwd /mnt/user/developer. cd to a project, then run: agy" },
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
