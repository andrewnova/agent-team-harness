const manual = require("./manual");
const mock = require("./mock");
const claudeChannel = require("./claudeChannel");
const mailbox = require("./mailbox");

function createBridge(name, options = {}) {
  if (name === "manual") return manual.create(options);
  if (name === "mock") return mock.create(options);
  if (name === "mailbox") return mailbox.create(options);
  if (name === "claude-channel") return claudeChannel.create(options);
  throw new Error(`unknown bridge adapter: ${name}`);
}

module.exports = {
  createBridge
};
