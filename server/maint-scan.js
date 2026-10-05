// Maintenance scanner for the nexus Maintenance panel. Runs in a throwaway
// container with the HOST pid namespace (`docker run --pid=host --privileged`,
// started by server/maint.js), so it sees every process on the box: host-native
// tools (codex), and everything inside containers (claude in claude-helper,
// opencode, ...).
//
// It answers one question per tool session: is anyone still attached to it?
//   - A `docker exec` session is attached if its client (`docker exec ...`
//     process -- in nexus, a host shell, Blink, ...) is still alive. Client and
//     session start within moments of each other, so they're paired by start
//     time. No living client = orphaned: the exec outlived whoever started it.
//   - A host-native session is attached if an sshd session / terminal
//     multiplexer is among its ancestors; otherwise it was abandoned to init.
// Only orphaned tool sessions are ever killable, and `kill` mode re-scans and
// re-checks every target (pid + start time) before signalling anything.
//
// Usage: node maint-scan.js scan          -> JSON report on stdout
//        node maint-scan.js kill '<json>' -> JSON results ([{pid,start}] in)
// Context (container id/name/init-pid map) comes in MAINT_CTX from maint.js.
"use strict";
const fs = require("fs");

const CTX = JSON.parse(process.env.MAINT_CTX || "{}");
const CONTAINERS = CTX.containers || {}; // full id -> { name, initPid }
const NEXUS = CTX.nexusContainer || "remote-terminal";
const HZ = 100;
const PAIR_WINDOW_S = 5; // client and exec'd process start within this

// Which tab each tool belongs to, and how to spot its processes.
const TOOLS = [
  { tool: "claude", tab: "Claude Terminal", match: (c) => /^claude( |$)/.test(c) },
  { tool: "codex", tab: "Codex Terminal", match: (c) => /(^|\/)codex( |$)|@openai\/codex/.test(c) && !/npm /.test(c) },
  { tool: "opencode", tab: "OpenCode", match: (c) => /(^|\/)opencode( |$)/.test(c) },
];
// Background services a tool starts on purpose (they outlive sessions by
// design): always protected.
const SERVICE = /app-server|--daemon|serve( |$)/;
const TERMINAL_HOST = /^(sshd: |tmux|zellij|mosh-server|screen|SCREEN|\/usr\/sbin\/sshd|login )/;

function read(path) { try { return fs.readFileSync(path, "utf8"); } catch (_) { return null; } }

function snapshot() {
  const btime = Number((read("/proc/stat") || "").match(/^btime (\d+)/m)?.[1] || 0);
  const procs = new Map();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const stat = read(`/proc/${d}/stat`);
    if (!stat) continue;
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cmd = (read(`/proc/${d}/cmdline`) || "").split("\0").filter(Boolean).join(" ");
    const cg = read(`/proc/${d}/cgroup`) || "";
    // The container id is the 64-hex path segment (works whether the cgroup
    // path reads /docker/<id> or, from a private cgroupns, /../<id>).
    const cid = cg.match(/\/([0-9a-f]{64})(?:\/|\.scope|$)/m)?.[1] || cg.match(/([0-9a-f]{64})/)?.[1] || null;
    // Host-native only when the cgroup is clearly outside any container.
    const hostNative = !cid && /^0::\/(init\.scope|system\.slice|user\.slice)?/m.test(cg) && !/docker|containerd|libpod/.test(cg);
    const rss = Number((read(`/proc/${d}/status`) || "").match(/VmRSS:\s+(\d+)/)?.[1] || 0);
    procs.set(Number(d), {
      pid: Number(d), state: rest[0], ppid: Number(rest[1]),
      start: Number(rest[19]), cpu: Number(rest[11]) + Number(rest[12]),
      cmd, cid, hostNative, rss, kthread: cmd === "" && rest[0] !== "Z",
      comm: (stat.match(/\((.*)\)/) || [])[1] || "",
    });
  }
  for (const p of procs.values()) {
    p.container = p.cid ? (CONTAINERS[p.cid]?.name || p.cid.slice(0, 12)) : "host";
    p.startedAt = btime + p.start / HZ;
  }
  return procs;
}

function children(procs) {
  const kids = new Map();
  for (const p of procs.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  return kids;
}
function subtree(pid, kids) {
  const out = [pid];
  for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) || []));
  return out;
}
function ancestors(p, procs) {
  const out = [];
  for (let q = procs.get(p.ppid); q && !out.includes(q); q = procs.get(q.ppid)) out.push(q);
  return out;
}
function env(pid) {
  const e = read(`/proc/${pid}/environ`);
  return e ? Object.fromEntries(e.split("\0").filter(Boolean).map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)])) : {};
}

// The container a `docker exec` client targets: first non-flag argument after "exec".
const VALUE_FLAGS = new Set(["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file", "--detach-keys"]);
function execTarget(cmd) {
  const a = cmd.split(" ");
  const i = a.findIndex((x, n) => x === "exec" && /(^|\/)docker$/.test(a[n - 1] || a[0]));
  if (i < 0) return null;
  for (let j = i + 1; j < a.length; j++) {
    if (VALUE_FLAGS.has(a[j])) { j++; continue; }
    if (a[j].startsWith("-")) continue;
    return a[j];
  }
  return null;
}

function classify(procs) {
  const kids = children(procs);
  // nexus reaches the host over ssh from its own container. An sshd session
  // is nexus's if a live ssh client in the nexus container started with it.
  const nexusSsh = [...procs.values()].filter((c) => c.container === NEXUS && /^ssh /.test(c.cmd));
  const sshdOf = (p) => ancestors(p, procs).find((a) => /^sshd(-session)?: /.test(a.cmd));
  const viaNexusSsh = (p) => {
    const s = sshdOf(p);
    return !!s && nexusSsh.some((c) => Math.abs(c.startedAt - s.startedAt) <= PAIR_WINDOW_S);
  };
  const byName = {};
  for (const [id, c] of Object.entries(CONTAINERS)) byName[c.name] = { id, ...c };

  // Live docker exec clients, anywhere on the box.
  const clients = [...procs.values()].filter((p) => !p.kthread && p.state !== "Z" && execTarget(p.cmd));
  for (const c of clients) {
    c.target = execTarget(c.cmd);
    c.via = c.container === NEXUS ? "nexus" : (c.container === "host" ? "host" : c.container);
    // A client on the host started from nexus's ssh shows an sshd ancestor;
    // nexus's ssh clients live in the nexus container.
    if (c.via === "host" && sshdOf(c)) c.via = viaNexusSsh(c) ? "nexus" : "host (ssh)";
  }
  const used = new Set();

  const sessions = [];
  const seenRoots = new Set();
  for (const p of procs.values()) {
    if (p.state === "Z" || p.kthread) continue;
    const t = TOOLS.find((x) => x.match(p.cmd));
    if (!t) continue;

    let root, status, client = null, reason;
    if (p.cid) {
      // Inside a container: walk up to the exec'd root (parent outside the container).
      const init = CONTAINERS[p.cid]?.initPid;
      root = p;
      while (procs.get(root.ppid)?.cid === p.cid && root.ppid !== init) root = procs.get(root.ppid);
      if (SERVICE.test(p.cmd)) {
        status = "service"; reason = `${t.tool} background service (runs on purpose)`;
      } else if (root.pid === init || root.ppid === init) {
        status = "attached"; reason = "part of the container's own service";
      } else {
        const name = CONTAINERS[p.cid]?.name;
        const cands = clients.filter((c) => !used.has(c.pid) &&
          (c.target === name || (c.target && p.cid.startsWith(c.target))) &&
          Math.abs(c.startedAt - root.startedAt) <= PAIR_WINDOW_S)
          .sort((a, b) => Math.abs(a.startedAt - root.startedAt) - Math.abs(b.startedAt - root.startedAt));
        if (cands[0]) {
          used.add(cands[0].pid);
          client = { pid: cands[0].pid, via: cands[0].via };
          status = cands[0].via === "nexus" ? "nexus" : "attached";
          reason = `client alive (${cands[0].via}, pid ${cands[0].pid})`;
        } else {
          status = "orphan"; reason = "its docker exec client is gone";
        }
      }
    } else if (!p.hostNative) {
      // Fail safe: couldn't tell which container this is in -- never offer it.
      root = p;
      status = "attached"; reason = "location unknown (protected)";
    } else {
      // Host-native: the topmost ancestor that's still part of this tool.
      root = p;
      while (procs.get(root.ppid) && t.match(procs.get(root.ppid).cmd)) root = procs.get(root.ppid);
      const anc = ancestors(root, procs);
      const host = anc.find((a) => TERMINAL_HOST.test(a.cmd));
      const viaNexus = viaNexusSsh(root);
      if (SERVICE.test(p.cmd)) { status = "service"; reason = `${t.tool} background service (runs on purpose)`; }
      else if (host) { status = viaNexus ? "nexus" : "attached"; reason = `under ${host.cmd.split(" ").slice(0, 2).join(" ")}`; }
      else { status = "orphan"; reason = "abandoned to init (no terminal session above it)"; }
    }
    if (seenRoots.has(root.pid)) continue;
    seenRoots.add(root.pid);

    const tree = subtree(root.pid, kids).map((x) => procs.get(x)).filter(Boolean);
    // Never offer anything in the nexus container itself.
    if (root.container === NEXUS) { status = "nexus"; reason = "runs inside nexus"; }
    const e = env(p.pid);
    sessions.push({
      tab: t.tab, tool: t.tool, container: root.container,
      pid: root.pid, start: root.start, toolPid: p.pid,
      cmd: p.cmd.slice(0, 120), startedAt: Math.round(root.startedAt),
      procs: tree.length, rssKB: tree.reduce((s, x) => s + x.rss, 0),
      cpuTicks: tree.reduce((s, x) => s + x.cpu, 0),
      nexusTag: e.NEXUS_TOOL || null,
      status, reason, client, killable: status === "orphan",
    });
  }

  // Zombies, grouped by container and parent.
  const zmap = new Map();
  for (const p of procs.values()) {
    if (p.state !== "Z") continue;
    const parent = procs.get(p.ppid);
    const key = `${p.container}|${p.ppid}`;
    if (!zmap.has(key)) zmap.set(key, {
      container: p.container, parentPid: p.ppid,
      parentCmd: parent ? parent.cmd.slice(0, 80) : "?",
      parentIsInit: CONTAINERS[p.cid]?.initPid === p.ppid || p.ppid === 1,
      count: 0, names: {},
    });
    const z = zmap.get(key);
    z.count++; z.names[p.comm] = (z.names[p.comm] || 0) + 1;
  }
  return { sessions, zombies: [...zmap.values()].sort((a, b) => b.count - a.count) };
}

function scan() {
  const a = snapshot();
  const t0 = Date.now();
  while (Date.now() - t0 < 1000) {} // ~1 s sample window for CPU%
  const b = snapshot();
  const out = classify(b);
  for (const s of out.sessions) {
    const tree = [];
    // CPU% = tick delta over the sample window across the session's tree.
    const kids = children(b);
    for (const x of subtree(s.pid, kids)) {
      const pa = a.get(x), pb = b.get(x);
      if (pa && pb && pa.start === pb.start) tree.push(pb.cpu - pa.cpu);
    }
    s.cpuPct = Math.round(tree.reduce((x, y) => x + y, 0) * 100 / HZ / ((Date.now() - t0) / 1000 || 1));
  }
  return { scannedAt: Math.round(Date.now() / 1000), ...out };
}

function kill(targets) {
  const results = [];
  if (!Object.keys(CONTAINERS).length) return { results: targets.map((t) => ({ pid: t.pid, ok: false, error: "refused: no container map" })) };
  const first = classify(snapshot());
  const victims = [];
  for (const t of targets) {
    const s = first.sessions.find((x) => x.pid === t.pid && x.start === t.start);
    if (!s) { results.push({ pid: t.pid, ok: false, error: "no longer exists (or pid reused)" }); continue; }
    if (!s.killable) { results.push({ pid: t.pid, ok: false, error: `refused: ${s.status} (${s.reason})` }); continue; }
    victims.push(s);
  }
  const procs = snapshot(), kids = children(procs);
  const pids = new Map();
  for (const s of victims) {
    const tree = subtree(s.pid, kids).filter((x) => procs.get(x)?.container !== NEXUS);
    pids.set(s.pid, tree);
    for (const x of tree.reverse()) { try { process.kill(x, "SIGTERM"); } catch (_) {} }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {}
  for (const s of victims) {
    let forced = 0;
    for (const x of pids.get(s.pid)) {
      const st = read(`/proc/${x}/stat`);
      if (st && st.slice(st.lastIndexOf(")") + 2, st.lastIndexOf(")") + 3) !== "Z") {
        try { process.kill(x, "SIGKILL"); forced++; } catch (_) {}
      }
    }
    results.push({ pid: s.pid, ok: true, tool: s.tool, freedKB: s.rssKB, forced });
  }
  return { results };
}

const mode = process.argv[2];
try {
  if (mode === "scan") process.stdout.write(JSON.stringify(scan()));
  else if (mode === "kill") process.stdout.write(JSON.stringify(kill(JSON.parse(process.argv[3] || "[]"))));
  else throw new Error("usage: maint-scan.js scan|kill <json>");
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
}
