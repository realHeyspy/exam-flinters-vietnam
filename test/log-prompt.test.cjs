const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

test("prompt logging preserves existing history and multiline Unicode without executing text", () => {
  const root = mkdtempSync(join(tmpdir(), "prompt log "));
  try {
    mkdirSync(join(root, ".claude"));
    const script = join(root, ".claude/log-prompt.cjs");
    copyFileSync(join(__dirname, "../.claude/log-prompt.cjs"), script);
    const log = join(root, "prompts.md");
    writeFileSync(log, "# Existing history\n", "utf8");

    const prompts = ["Tiếng Việt 🐈\n```\n$(do-not-execute)\n\nlast line", "same prompt", "same prompt"];
    for (const prompt of prompts) {
      const result = spawnSync(process.execPath, [script, "ChatGPT"], {
        input: "\uFEFF" + JSON.stringify({ prompt }),
        encoding: "utf8",
        cwd: tmpdir(),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }

    const entries = readFileSync(log, "utf8").split(/\n## [^\n]+\n\n/);
    assert.equal(entries.shift(), "# Existing history\n");
    assert.deepEqual(entries.map((entry) => entry.slice(2, -1).replaceAll("\n> ", "\n")), prompts);

    const before = readFileSync(log, "utf8");
    for (const input of ["{", "{}", '{"prompt":42}']) {
      const result = spawnSync(process.execPath, [script], { input, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(log, "utf8"), before);
    }

    rmSync(log);
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ prompt: "first prompt" }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(log, "utf8"), /\| Claude Code\n\n> first prompt\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
