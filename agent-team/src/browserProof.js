const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const paths = require("./paths");
const { ensureDir, readJson, writeJson, exists } = require("./fsutil");
const { loadTask, recordEvent } = require("./state");
const { sourceSnapshot } = require("./sourceSnapshot");
const { checkUrlPort } = require("./portCheck");

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function defaultRunId() {
  return `browser-run-${new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "-").replace(/-$/, "")}`;
}

function relative(cwd, file) {
  return path.relative(cwd, file) || file;
}

function parseViewport(value) {
  const match = String(value || "1280x720").match(/^(\d{3,5})x(\d{3,5})$/);
  if (!match) throw new Error("--viewport must look like 1280x720");
  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}

function normalizeUrl(cwd, value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("--url <url> is required");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  const file = path.isAbsolute(value) ? value : path.join(cwd, value);
  return pathToFileURL(file).href;
}

function artifactExists(cwd, reference) {
  if (!reference) return false;
  const file = path.isAbsolute(reference) ? reference : path.join(cwd, reference);
  return exists(file);
}

function firstPng(runDir) {
  const dir = path.join(runDir, "screenshots");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".png")).sort();
  return files[0] ? path.join(dir, files[0]) : null;
}

function browserFailures(consoleCheck) {
  if (!consoleCheck) return ["console check missing"];
  return [
    ...(consoleCheck.errors || []).map((row) => `console error: ${row.text || row.message || JSON.stringify(row)}`),
    ...(consoleCheck.page_errors || []).map((row) => `page error: ${row.message || JSON.stringify(row)}`),
    ...(consoleCheck.request_failures || []).map((row) => `request failed: ${row.url || JSON.stringify(row)}`)
  ];
}

function writeFindings(cwd, task, runId, runDir, url, viewport, source, portStatus, artifacts, consoleCheck, ok) {
  const failures = browserFailures(consoleCheck);
  const findingsPath = path.join(runDir, "browser-findings.json");
  const findings = {
    ok,
    task_id: task.task_id,
    goal_id: task.goal_id,
    run_id: runId,
    url,
    viewport,
    source_digest: source.source_digest,
    port_status: portStatus,
    artifacts,
    console_summary: consoleCheck
      ? {
          errors: (consoleCheck.errors || []).length,
          warnings: (consoleCheck.warnings || []).length,
          page_errors: (consoleCheck.page_errors || []).length,
          request_failures: (consoleCheck.request_failures || []).length
        }
      : null,
    failures,
    suggested_next_action: failures.length
      ? "Send this findings JSON to the frontend builder, fix the listed browser/console failures, then rerun verify browser."
      : "Browser proof is clean; pass these artifacts to verify run or let verify run reattach them automatically.",
    mailbox_handoff: {
      from: "codex",
      to: "claude",
      kind: "notify",
      task_id: task.task_id,
      goal_id: task.goal_id,
      subject: `Browser proof findings for ${task.task_id}`,
      body_file: relative(cwd, findingsPath)
    },
    completed_at: new Date().toISOString()
  };
  writeJson(findingsPath, findings);
  return relative(cwd, findingsPath);
}

function writeFakeArtifacts(cwd, task, runId, runDir, url, viewport, screenshotPath, source, portStatus) {
  ensureDir(path.dirname(screenshotPath));
  fs.writeFileSync(screenshotPath, Buffer.from(TINY_PNG, "base64"));
  const browserRunPath = path.join(runDir, "browser-run.json");
  const consoleCheckPath = path.join(runDir, "console-check.json");
  const browserRun = {
    ok: true,
    fake: true,
    task_id: task.task_id,
    run_id: runId,
    url,
    viewport,
    source_digest: source.source_digest,
    port_status: portStatus,
    interactions: [],
    completed_at: new Date().toISOString()
  };
  const consoleCheck = {
    ok: true,
    fake: true,
    task_id: task.task_id,
    run_id: runId,
    errors: [],
    warnings: [],
    page_errors: [],
    request_failures: [],
    completed_at: new Date().toISOString()
  };
  writeJson(browserRunPath, browserRun);
  writeJson(consoleCheckPath, consoleCheck);
  const artifacts = {
    browser_run: relative(cwd, browserRunPath),
    screenshot: relative(cwd, screenshotPath),
    console_check: relative(cwd, consoleCheckPath)
  };
  artifacts.findings = writeFindings(cwd, task, runId, runDir, url, viewport, source, portStatus, artifacts, consoleCheck, true);
  return {
    ok: true,
    browserRun,
    consoleCheck,
    artifacts
  };
}

async function launchContext(playwright, viewport) {
  const errors = [];
  try {
    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport });
    return {
      context,
      close: () => browser.close(),
      engine: "playwright-chromium"
    };
  } catch (error) {
    errors.push(`bundled chromium: ${error.message}`);
  }
  if (fs.existsSync(SYSTEM_CHROME)) {
    try {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-browser-"));
      const context = await playwright.chromium.launchPersistentContext(userDataDir, {
        executablePath: SYSTEM_CHROME,
        headless: true,
        viewport,
        args: ["--no-sandbox", "--disable-dev-shm-usage"]
      });
      return {
        context,
        close: () => context.close(),
        engine: "system-google-chrome"
      };
    } catch (error) {
      errors.push(`system chrome: ${error.message}`);
    }
  }
  const message = errors.length ? errors.join("\n") : "no Playwright browser launch path was available";
  throw new Error(message);
}

async function runBrowserProof(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  const runId = options.run_id || defaultRunId();
  const runDir = paths.evidenceDir(cwd, taskId, runId);
  const url = normalizeUrl(cwd, options.url);
  const viewport = parseViewport(options.viewport);
  const screenshotPath = path.join(runDir, "screenshots", options.screenshot_name || `browser-${viewport.width}x${viewport.height}.png`);
  const source = sourceSnapshot(cwd);
  const portStatus = await checkUrlPort(url, { next: true });

  if (process.env.AGENT_TEAM_FAKE_BROWSER_PROOF === "1" || options.fake) {
    const fake = writeFakeArtifacts(cwd, task, runId, runDir, url, viewport, screenshotPath, source, portStatus);
    recordEvent(cwd, {
      type: "browser.proof",
      goal_id: task.goal_id,
      task_id: task.task_id,
      owner: task.owner,
      reviewer: task.reviewer,
      status: task.status,
      detail: {
        run_id: runId,
        fake: true,
        ok: true,
        source_digest: source.source_digest,
        port_status: portStatus,
        artifacts: fake.artifacts
      }
    });
    return {
      ok: true,
      task_id: task.task_id,
      run_id: runId,
      evidence_dir: runDir,
      artifacts: fake.artifacts,
      verify_args: [
        "--browser-run",
        fake.artifacts.browser_run,
        "--screenshot",
        fake.artifacts.screenshot,
        "--console-check",
        fake.artifacts.console_check
      ]
    };
  }

  const browserRunPath = path.join(runDir, "browser-run.json");
  const consoleCheckPath = path.join(runDir, "console-check.json");
  const errors = [];
  const warnings = [];
  const pageErrors = [];
  const requestFailures = [];
  let launcher;
  try {
    const playwright = require("playwright");
    launcher = await launchContext(playwright, viewport);
    const page = await launcher.context.newPage();
    page.on("console", (message) => {
      const row = { type: message.type(), text: message.text(), location: message.location() };
      if (message.type() === "error") errors.push(row);
      if (message.type() === "warning") warnings.push(row);
    });
    page.on("pageerror", (error) => pageErrors.push({ message: error.message, stack: error.stack }));
    page.on("requestfailed", (request) => {
      requestFailures.push({
        url: request.url(),
        method: request.method(),
        failure: request.failure()
      });
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeout_ms || 30000 });
    if (options.script) {
      const scriptPath = path.isAbsolute(options.script) ? options.script : path.join(cwd, options.script);
      const scriptSource = fs.readFileSync(scriptPath, "utf8");
      await page.evaluate((source) => {
        const fn = new Function(source);
        return fn();
      }, scriptSource);
    }
    if (options.wait_ms) await page.waitForTimeout(options.wait_ms);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const ok = errors.length === 0 && pageErrors.length === 0 && requestFailures.length === 0;
    const browserRun = {
      ok,
      fake: false,
      task_id: task.task_id,
      run_id: runId,
      url,
      viewport,
      engine: launcher.engine,
      source_digest: source.source_digest,
      port_status: portStatus,
      screenshot: relative(cwd, screenshotPath),
      completed_at: new Date().toISOString()
    };
    const consoleCheck = {
      ok,
      fake: false,
      task_id: task.task_id,
      run_id: runId,
      errors,
      warnings,
      page_errors: pageErrors,
      request_failures: requestFailures,
      completed_at: new Date().toISOString()
    };
    writeJson(browserRunPath, browserRun);
    writeJson(consoleCheckPath, consoleCheck);
    const artifacts = {
      browser_run: relative(cwd, browserRunPath),
      screenshot: relative(cwd, screenshotPath),
      console_check: relative(cwd, consoleCheckPath)
    };
    artifacts.findings = writeFindings(cwd, task, runId, runDir, url, viewport, source, portStatus, artifacts, consoleCheck, ok);
    recordEvent(cwd, {
      type: "browser.proof",
      goal_id: task.goal_id,
      task_id: task.task_id,
      owner: task.owner,
      reviewer: task.reviewer,
      status: task.status,
      detail: {
        run_id: runId,
        fake: false,
        ok,
        engine: launcher.engine,
        source_digest: source.source_digest,
        port_status: portStatus,
        artifacts
      }
    });
    return {
      ok,
      task_id: task.task_id,
      run_id: runId,
      evidence_dir: runDir,
      artifacts,
      console_summary: {
        errors: errors.length,
        warnings: warnings.length,
        page_errors: pageErrors.length,
        request_failures: requestFailures.length
      },
      verify_args: [
        "--browser-run",
        artifacts.browser_run,
        "--screenshot",
        artifacts.screenshot,
        "--console-check",
        artifacts.console_check
      ]
    };
  } catch (error) {
    const failure = {
      ok: false,
      task_id: task.task_id,
      run_id: runId,
      error: error.message,
      completed_at: new Date().toISOString(),
      hints: [
        "If sandboxing blocks Chromium on macOS, run this command with local process/browser permissions.",
        "Use AGENT_TEAM_FAKE_BROWSER_PROOF=1 only for deterministic tests, not MVP-final proof."
      ]
    };
    writeJson(browserRunPath, failure);
    recordEvent(cwd, {
      type: "browser.proof_failed",
      goal_id: task.goal_id,
      task_id: task.task_id,
      owner: task.owner,
      reviewer: task.reviewer,
      status: task.status,
      detail: {
        run_id: runId,
        error: error.message
      }
    });
    return failure;
  } finally {
    if (launcher) await launcher.close();
  }
}

function findReusableBrowserProof(cwd, taskId, options = {}) {
  const taskDir = path.join(paths.rootDir(cwd), "evidence", taskId);
  if (!fs.existsSync(taskDir)) {
    return {
      ok: false,
      reason: "no browser proof evidence directory"
    };
  }
  const runDirs = fs.readdirSync(taskDir)
    .map((entry) => path.join(taskDir, entry))
    .filter((entry) => fs.statSync(entry).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const stale = [];
  for (const runDir of runDirs) {
    const browserRunPath = path.join(runDir, "browser-run.json");
    if (!fs.existsSync(browserRunPath)) continue;
    let browserRun;
    try {
      browserRun = readJson(browserRunPath);
    } catch (error) {
      stale.push({ run_id: path.basename(runDir), reason: `browser-run.json unreadable: ${error.message}` });
      continue;
    }
    if (browserRun.ok === false) {
      stale.push({ run_id: path.basename(runDir), reason: "browser proof was not ok" });
      continue;
    }
    if (options.source_digest && browserRun.source_digest !== options.source_digest) {
      stale.push({ run_id: path.basename(runDir), reason: "source digest mismatch or missing" });
      continue;
    }
    const screenshot = browserRun.screenshot ? path.join(cwd, browserRun.screenshot) : firstPng(runDir);
    const consoleCheck = path.join(runDir, "console-check.json");
    const findings = path.join(runDir, "browser-findings.json");
    const artifacts = {
      browser_run: relative(cwd, browserRunPath),
      screenshot: screenshot ? relative(cwd, screenshot) : null,
      console_check: relative(cwd, consoleCheck),
      findings: fs.existsSync(findings) ? relative(cwd, findings) : null
    };
    const missing = Object.entries(artifacts)
      .filter(([key, value]) => key !== "findings" && !artifactExists(cwd, value))
      .map(([key]) => key);
    if (missing.length) {
      stale.push({ run_id: path.basename(runDir), reason: `missing artifacts: ${missing.join(", ")}` });
      continue;
    }
    return {
      ok: true,
      run_id: browserRun.run_id || path.basename(runDir),
      source_digest: browserRun.source_digest,
      completed_at: browserRun.completed_at,
      artifacts,
      stale_candidates: stale.slice(0, 5)
    };
  }
  return {
    ok: false,
    reason: "no reusable browser proof for current source digest",
    stale_candidates: stale.slice(0, 5)
  };
}

module.exports = {
  runBrowserProof,
  findReusableBrowserProof,
  parseViewport,
  normalizeUrl
};
