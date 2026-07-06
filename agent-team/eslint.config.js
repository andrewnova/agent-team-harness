// Minimal flat config focused on catching undefined references (the class of bug
// that shipped as the daemon `spawnSync`/`isReplyTimeout` and bridge `endpointTarget`
// crashes). Intentionally narrow: no style rules, just correctness signal.
const nodeGlobals = {
  require: "readonly",
  module: "writable",
  exports: "writable",
  process: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
  globalThis: "readonly",
  structuredClone: "readonly"
};

module.exports = [
  {
    files: ["src/**/*.js", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: nodeGlobals
    },
    rules: {
      "no-undef": "error"
    }
  }
];
