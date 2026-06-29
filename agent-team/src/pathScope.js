const path = require("node:path");

function normalizePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
  const normalized = path.posix.normalize(raw);
  return normalized === "." ? "" : normalized;
}

function normalizeChangedPath(value, label = "changed path") {
  const raw = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!raw) throw new Error(`${label} must be a non-empty relative path`);
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`${label} must be a relative path`);
  }
  if (raw.split("/").includes("..")) {
    throw new Error(`${label} must not contain path traversal`);
  }
  return normalizePath(raw);
}

function normalizeChangedPathSet(values, options = {}) {
  const label = options.label || "changed path";
  return (Array.isArray(values) ? values : []).map((value) => normalizeChangedPath(value, label));
}

function patternBase(pattern) {
  const normalized = normalizePath(pattern);
  if (!normalized || normalized === "*" || normalized === "**" || normalized === "**/*") return "*";
  const wildcard = normalized.search(/[*?\[]/);
  const base = wildcard === -1 ? normalized : normalized.slice(0, wildcard);
  return base.replace(/\/+$/, "");
}

function pathMatchesPattern(file, pattern) {
  const normalized = normalizePath(file);
  const base = patternBase(pattern);
  if (base === "*") return true;
  if (normalizePath(pattern) === normalized) return true;
  return normalized.startsWith(`${base}/`);
}

function isPathAllowed(file, taskOrPolicy = {}) {
  const raw = String(file || "").replace(/\\/g, "/");
  const normalized = normalizePath(raw);
  if (
    !normalized ||
    path.posix.isAbsolute(raw) ||
    /^[A-Za-z]:\//.test(raw) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return false;
  }
  const allowed = taskOrPolicy.allowed_paths && taskOrPolicy.allowed_paths.length ? taskOrPolicy.allowed_paths : ["*"];
  const forbidden = taskOrPolicy.forbidden_paths || [];
  if (forbidden.some((pattern) => pathMatchesPattern(normalized, pattern))) return false;
  return allowed.some((pattern) => pathMatchesPattern(normalized, pattern));
}

function validateChangedPaths(values, taskOrPolicy = {}, options = {}) {
  const label = options.label || "changed path";
  const scopeLabel = options.scope_label || "changed_paths";
  const normalized = normalizeChangedPathSet(values, { label });
  const outOfScope = normalized.filter((file) => !isPathAllowed(file, taskOrPolicy));
  if (outOfScope.length) {
    throw new Error(`${scopeLabel} outside task scope: ${outOfScope.join(", ")}`);
  }
  return normalized;
}

module.exports = {
  normalizePath,
  normalizeChangedPath,
  normalizeChangedPathSet,
  pathMatchesPattern,
  isPathAllowed,
  pathAllowed: isPathAllowed,
  validateChangedPaths
};
