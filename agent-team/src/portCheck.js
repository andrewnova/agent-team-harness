const net = require("node:net");
const { spawnSync } = require("node:child_process");

function normalizeHost(value) {
  return value || "127.0.0.1";
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
  return port;
}

function listenProbe(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      resolve({
        free: false,
        code: error.code,
        error: error.message
      });
    });
    server.once("listening", () => {
      server.close(() => resolve({ free: true }));
    });
    server.listen(port, host);
  });
}

function ownerForPort(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    return {
      available: false,
      reason: result.error ? result.error.message : (result.stderr || "no listener details").trim()
    };
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { available: false, reason: "no listener rows" };
  const rows = lines.slice(1).map((line) => {
    const columns = line.trim().split(/\s+/);
    return {
      command: columns[0],
      pid: columns[1],
      user: columns[2],
      name: columns.slice(8).join(" ")
    };
  });
  return {
    available: true,
    rows
  };
}

async function findNextFreePort(host, startPort) {
  for (let port = startPort; port <= 65535; port += 1) {
    const probe = await listenProbe(host, port);
    if (probe.free) return port;
    if (probe.code && probe.code !== "EADDRINUSE") {
      throw new Error(`port probe blocked while searching for next free port: ${probe.code} ${probe.error || ""}`.trim());
    }
  }
  throw new Error(`no free port found at or above ${startPort}`);
}

function fakeOccupiedPorts() {
  const raw = process.env.AGENT_TEAM_FAKE_OCCUPIED_PORTS;
  if (!raw) return null;
  return new Set(
    raw
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item > 0)
  );
}

function fakeCheckPort(host, port, options = {}) {
  const occupiedPorts = fakeOccupiedPorts();
  if (!occupiedPorts) return null;
  const occupied = occupiedPorts.has(port);
  let selected = port;
  if (occupied && options.next) {
    selected = port + 1;
    while (occupiedPorts.has(selected)) selected += 1;
  }
  return {
    ok: true,
    fake: true,
    host,
    port,
    occupied,
    free: !occupied,
    owner: occupied
      ? {
          available: true,
          rows: [{ command: "fake-listener", pid: "0", user: "test", name: `TCP ${host}:${port}` }]
        }
      : null,
    selected_port: selected,
    selected_url_hint: `http://${host}:${selected}`,
    reuse_safe: occupied,
    action: occupied ? (options.next ? "use_next_free_port" : "reuse_or_stop_existing_server") : "use_requested_port",
    probe: { free: !occupied, fake: true }
  };
}

async function checkPort(options = {}) {
  const host = normalizeHost(options.host);
  const port = normalizePort(options.port);
  const fake = fakeCheckPort(host, port, options);
  if (fake) return fake;
  const probe = await listenProbe(host, port);
  const occupied = !probe.free && probe.code === "EADDRINUSE";
  const probeBlocked = !probe.free && !occupied;
  const owner = occupied ? ownerForPort(port) : null;
  const selected = occupied && options.next ? await findNextFreePort(host, port + 1) : port;
  return {
    ok: !probeBlocked,
    host,
    port,
    occupied,
    free: probe.free,
    probe_blocked: probeBlocked,
    owner,
    selected_port: selected,
    selected_url_hint: `http://${host}:${selected}`,
    reuse_safe: occupied,
    action: probeBlocked ? "port_probe_blocked" : occupied ? (options.next ? "use_next_free_port" : "reuse_or_stop_existing_server") : "use_requested_port",
    probe
  };
}

function urlPort(url) {
  try {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) return null;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "");
    if (!port) return null;
    return {
      host: parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname,
      port: Number(port)
    };
  } catch (_error) {
    return null;
  }
  return null;
}

async function checkUrlPort(url, options = {}) {
  const parsed = urlPort(url);
  if (!parsed) {
    return {
      checked: false,
      reason: "url is not a localhost URL with an explicit port"
    };
  }
  return {
    checked: true,
    ...(await checkPort({ ...parsed, next: Boolean(options.next) }))
  };
}

module.exports = {
  checkPort,
  checkUrlPort,
  urlPort
};
