const { spawnSync } = require("node:child_process");

function inventory() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 5000 });
  if (result.error || result.status !== 0) throw new Error("cannot observe native descendants; process ownership remains reserved");
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("unrecognized process inventory");
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4] };
  });
}

// Native CLIs start tool servers in separate process groups. Retain their
// identities while parentage is observable, and fence signals against PID reuse.
function trackProcesses(pid, { read = inventory, signal = process.kill } = {}) {
  const owned = new Map();
  function scan() {
    const rows = read();
    const live = new Map(rows.map((row) => [row.pid, row]));
    if (!owned.size && live.has(pid)) owned.set(pid, live.get(pid).started);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const parent = live.get(row.parent);
        if (parent && owned.get(parent.pid) === parent.started && !owned.has(row.pid)) {
          owned.set(row.pid, row.started);
          changed = true;
        }
      }
    }
    return rows.filter((row) => owned.get(row.pid) === row.started);
  }
  function stop(kind = "SIGTERM") {
    const live = scan();
    // Stop descendants before their parents; only observed identity matches.
    for (const row of [...live].reverse()) {
      try { signal(row.pid, kind); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    return live;
  }
  return { scan, stop, identities: () => Array.from(owned, ([pid, started]) => ({ pid, started })) };
}

module.exports = { inventory, trackProcesses };
