const { appendFileSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

function logPrompt(source, prompt) {
  if (typeof prompt !== "string") {
    throw new TypeError("Expected a string prompt; nothing was logged.");
  }

  const entry = `\n## ${new Date().toISOString()} | ${source}\n\n> ${prompt.replace(/\r?\n/g, "\n> ")}\n`;
  appendFileSync(resolve(__dirname, "../prompts.md"), entry, {
    encoding: "utf8",
    mode: 0o600,
  });
}

module.exports = logPrompt;

if (require.main === module) {
  const input = JSON.parse(readFileSync(0, "utf8").replace(/^\uFEFF/, ""));
  logPrompt(process.argv[2] || "Claude Code", input.prompt);
}
