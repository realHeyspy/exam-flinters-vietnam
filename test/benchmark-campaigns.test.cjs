const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { fixture, fixtureRow, totalsFor, referenceReports, INPUT_HEADER, REPORT_HEADER } = require("./benchmark-campaigns.cjs");

test("closed-form reference matches hand-counted partial cycles", () => {
  assert.deepEqual(totalsFor(0, 7, 3).totals, [0n, 0n, 4100n, 0n]);
  assert.deepEqual(totalsFor(1, 7, 3).totals, [402n, 3n, 3275n, 3n]);
  assert.deepEqual(totalsFor(2, 7, 3).totals, [404n, 5n, 3475n, 6n]);
  const [ctr, cpa] = referenceReports(7, 3);
  assert.equal(ctr, REPORT_HEADER + "CMP0000002,404,5,34.75,6,0.0124,5.79\nCMP0000001,402,3,32.75,3,0.0075,10.92\nCMP0000000,0,0,41.00,0,0.0000,\n");
  assert.equal(cpa, REPORT_HEADER + "CMP0000002,404,5,34.75,6,0.0124,5.79\nCMP0000001,402,3,32.75,3,0.0075,10.92\n");
  assert.deepEqual(referenceReports(0, 3), [REPORT_HEADER, REPORT_HEADER]);
});

test("bounded fixture honors byte target, digest, reuse, and conflict protection", async () => {
  const name = `test-${randomUUID()}`;
  let generated;
  try {
    generated = await fixture(name, 1000, 3);
    assert.equal(generated.rows, 15);
    assert.equal(generated.bytes, Buffer.byteLength(INPUT_HEADER) + 15 * 60);
    assert.ok(1000 - generated.bytes < 60);
    assert.equal(await fs.readFile(generated.file, "utf8"), INPUT_HEADER + Array.from({ length: 15 }, (_, i) => fixtureRow(i, 3)).join(""));
    const reused = await fixture(name, 1000, 3);
    assert.equal(reused.sha256, generated.sha256);
    await assert.rejects(fixture(name, 1001, 3), /conflict/);
    await fs.appendFile(generated.file, "bad");
    await assert.rejects(fixture(name, 1000, 3), /conflict/);
  } finally {
    if (generated) for (const file of [generated.file, `${generated.file}.json`, ...generated.references]) await fs.rm(file, { force: true });
  }
});

const os = require("node:os");
const { spawn, fork } = require("node:child_process");
const { parse: parseCsv } = require("csv-parse/sync");
const RUNNER = path.join(__dirname, "campaign-benchmark-runner.cjs");
const REPORT_NAMES = ["top10_ctr.csv", "top10_cpa.csv"];
const SENTINELS = ["existing CTR bytes\n", "existing CPA bytes\n"];
const cell = (value) => /[",\r\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
const inputCsv = (rows) => INPUT_HEADER + rows.map((row) => row.map(cell).join(",") + "\n").join("");
const row = (campaign, impressions = "100", clicks = "10", spend = "2.00", conversions = "1", date = "2024-02-29") =>
  [campaign, date, impressions, clicks, spend, conversions];

async function trial(t, csv) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-benchmark-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "in'put.csv"), output = path.join(root, "reports"), scratch = path.join(root, "scratch");
  await fs.mkdir(output);
  if (csv !== null) await fs.writeFile(input, csv);
  await Promise.all(REPORT_NAMES.map((name, index) => fs.writeFile(path.join(output, name), SENTINELS[index])));
  return {
    root, input, output, scratch,
    reports: () => Promise.all(REPORT_NAMES.map((name) => fs.readFile(path.join(output, name), "utf8"))),
    start(engine, { ipc = false, profile = "main", reportPath = output, inputPath = input } = {}) {
      const args = [engine, inputPath, reportPath, scratch, profile];
      const child = ipc ? fork(RUNNER, args, { silent: true }) :
        spawn(process.execPath, [RUNNER, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stderr = "", stdout = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      const timer = setTimeout(() => { child.kill(); }, 60000);
      const done = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr, stdout }); });
      });
      t.after(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); });
      return { child, done };
    }
  };
}

async function successful(t, engine, csv, options) {
  const files = await trial(t, csv);
  const result = await files.start(engine, options).done;
  assert.equal(result.code, 0, result.stderr);
  return files.reports();
}

async function invalid(t, engine, csv) {
  const files = await trial(t, csv);
  const result = await files.start(engine).done;
  assert.notEqual(result.code, 0, "invalid data must fail");
  assert.ok(result.stderr.trim(), "failure must be reported on stderr");
  assert.deepEqual(await files.reports(), SENTINELS, "validation failure must preserve both reports");
}

function ready(child, done) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type === "ready") { child.off("message", onMessage); resolve(); }
    };
    child.on("message", onMessage);
    done.then((result) => { child.off("message", onMessage); reject(new Error(`Runner closed before release: ${result.stderr}`)); }, reject);
  });
}

test("uncached fixture generation preserves fixed-width bytes", async () => {
  const name = `test-${randomUUID()}`;
  let generated;
  try {
    generated = await fixture(name, 1000, 40000);
    assert.equal(generated.rows, 15);
    assert.equal(generated.bytes, Buffer.byteLength(INPUT_HEADER) + 15 * 60);
    assert.equal(await fs.readFile(generated.file, "utf8"), INPUT_HEADER + Array.from({ length: 15 }, (_, i) => fixtureRow(i, 40000)).join(""));
    assert.equal((await fixture(name, 1000, 40000)).sha256, generated.sha256);
  } finally {
    if (generated) for (const file of [generated.file, `${generated.file}.json`, ...generated.references]) await fs.rm(file, { force: true });
  }
});

for (const engine of ["C", "D", "E"]) {
  test(`${engine}: aggregates across dates before calculating ratios`, async (t) => {
    const reports = await successful(t, engine, inputCsv([
      row("B", "100", "10", "1.00", "1", "2025-01-01"),
      row("A", "00000100", "00000010", "0000002.00", "00000001"),
      row("B", "900", "0", "9.00", "0", "2025-01-02")
    ]));
    const expected = REPORT_HEADER + "A,100,10,2.00,1,0.1000,2.00\nB,1000,10,10.00,1,0.0100,10.00\n";
    assert.deepEqual(reports, [expected, expected]);
  });

  test(`${engine}: limits both reports to ten and resolves ties by ordinal ID`, async (t) => {
    const ids = ["z", "a", "Z", "A", "aa", "Aa", "aA", "B", "b", "C", "c", "D"];
    const reports = await successful(t, engine, inputCsv(ids.map((id) => row(id))));
    const expected = [...ids].sort().slice(0, 10);
    for (const report of reports) {
      const records = parseCsv(report);
      assert.equal(records.length, 11);
      assert.deepEqual(records.slice(1).map((record) => record[0]), expected);
    }
  });

  test(`${engine}: ranks unrounded ratios, not displayed values`, async (t) => {
    const reports = await successful(t, engine, inputCsv([
      row("a-low-ctr", "100000", "10000", "10.01", "1000"),
      row("z-high-ctr", "100000", "10001", "10.00", "1000")
    ]));
    const ctr = parseCsv(reports[0]).slice(1), cpa = parseCsv(reports[1]).slice(1);
    assert.deepEqual(ctr.map((record) => record[0]), ["z-high-ctr", "a-low-ctr"]);
    assert.deepEqual(ctr.map((record) => record[5]), ["0.1000", "0.1000"]);
    assert.deepEqual(cpa.map((record) => record[0]), ["z-high-ctr", "a-low-ctr"]);
    assert.deepEqual(cpa.map((record) => record[6]), ["0.01", "0.01"]);
  });

  test(`${engine}: rounds exact half boundaries only after ranking`, async (t) => {
    const expected = REPORT_HEADER + "round,32,1,0.75,10,0.0313,0.08\n";
    assert.deepEqual(await successful(t, engine, inputCsv([row("round", "32", "1", "0.75", "10")])), [expected, expected]);
  });

  test(`${engine}: formats zero denominators and excludes zero-conversion CPA`, async (t) => {
    assert.deepEqual(await successful(t, engine, inputCsv([row("zero", "0", "0", "0", "0")])),
      [REPORT_HEADER + "zero,0,0,0.00,0,0.0000,\n", REPORT_HEADER]);
  });

  test(`${engine}: header-only input publishes two header-only reports`, async (t) => {
    assert.deepEqual(await successful(t, engine, INPUT_HEADER), [REPORT_HEADER, REPORT_HEADER]);
  });

  test(`${engine}: preserves CSV campaign identity including whitespace, quotes, CR and LF`, async (t) => {
    const id = '  campaign,"quoted"\r\nnext line  ';
    const reports = await successful(t, engine, inputCsv([row(id), row(id, "200", "20", "4.00", "2", "2025-01-01")]));
    for (const report of reports) {
      assert.deepEqual(parseCsv(report).slice(1), [[id, "300", "30", "6.00", "3", "0.1000", "2.00"]]);
    }
  });

  test(`${engine}: accepts reordered required columns and extra VARCHAR columns`, async (t) => {
    const csv = "unused,spend,clicks,campaign_id,conversions,date,impressions\nanything,2.00,00010,kept,0001,2000-02-29,00100\n";
    const expected = REPORT_HEADER + "kept,100,10,2.00,1,0.1000,2.00\n";
    assert.deepEqual(await successful(t, engine, csv), [expected, expected]);
  });

  const failures = [
    ["missing column", "campaign_id,date,impressions,clicks,spend\nA,2025-01-01,1,1,1\n"],
    ["duplicate required column", "campaign_id,date,impressions,clicks,spend,conversions,date\nA,2025-01-01,1,1,1,1,2025-01-01\n"],
    ["empty input", ""],
    ["missing input", null],
    ["empty campaign", inputCsv([row("")])],
    ["whitespace-only campaign", inputCsv([row(" \t\u00a0\u2003\r\n")])],
    ["non-leap date", inputCsv([row("bad", "1", "1", "1", "1", "2023-02-29")])],
    ["century non-leap date", inputCsv([row("bad", "1", "1", "1", "1", "1900-02-29")])],
    ["noncanonical date", inputCsv([row("bad", "1", "1", "1", "1", "2024-2-29")])],
    ["impossible day", inputCsv([row("bad", "1", "1", "1", "1", "2025-04-31")])],
    ["year zero", inputCsv([row("bad", "1", "1", "1", "1", "0000-01-01")])],
    ["negative count", inputCsv([row("bad", "-1")])],
    ["negative spend", inputCsv([row("bad", "1", "1", "-1")])],
    ["fractional count", inputCsv([row("bad", "1.5")])],
    ["fractional click count", inputCsv([row("bad", "1", "0.5")])],
    ["fractional conversion count", inputCsv([row("bad", "1", "1", "1", "0.5")])],
    ["NaN", inputCsv([row("bad", "1", "1", "NaN")])],
    ["Infinity", inputCsv([row("bad", "1", "1", "Infinity")])],
    ["exponent spend", inputCsv([row("bad", "1", "1", "1e2")])],
    ["leading plus", inputCsv([row("bad", "+1")])],
    ["padded numeric value", inputCsv([row("bad", "1", " 1")])],
    ["empty numeric value", inputCsv([row("bad", "1", "1", "")])],
    ["leading-point spend", inputCsv([row("bad", "1", "1", ".5")])],
    ["trailing-point spend", inputCsv([row("bad", "1", "1", "1.")])],
    ["row count overflow", inputCsv([row("bad", "9007199254740992")])],
    ["row spend overflow", inputCsv([row("bad", "1", "1", "9007199254740992")])],
    ["too few fields", INPUT_HEADER + "A,2025-01-01,1,1,1\n"],
    ["too many fields", INPUT_HEADER + "A,2025-01-01,1,1,1,1,extra\n"],
    ["unclosed quotation", INPUT_HEADER + '"bad,2025-01-01,1,1,1,1\n'],
    ["characters after closing quote", INPUT_HEADER + '"bad"x,2025-01-01,1,1,1,1\n'],
    ["bad late row after valid data", inputCsv([row("valid")]) + "bad,2025-02-29,1,1,1,1\n"]
  ];
  for (const [name, csv] of failures) {
    test(`${engine}: rejects ${name} without replacing reports`, (t) => invalid(t, engine, csv));
  }

  for (const index of [2, 3, 4, 5]) {
    test(`${engine}: rejects aggregate overflow in ${["impressions", "clicks", "spend", "conversions"][index - 2]} outside the top ten`, async (t) => {
      const first = row("overflow", "0", "0", "1", "0"), second = [...first];
      first[index] = "9007199254740991";
      second[index] = "1";
      // Overflow validation must consume every aggregate, even one ranking last.
      const rows = Array.from({ length: 12 }, (_, i) => row(`A${i}`, "1", "1", "0", "1"));
      await invalid(t, engine, inputCsv([...rows, first, second]));
    });
  }

  test(`${engine}: rejects report-path conflicts without claiming success`, async (t) => {
    const files = await trial(t, inputCsv([row("valid")]));
    const conflict = path.join(files.output, "top10_cpa.csv");
    await fs.rm(conflict);
    await fs.mkdir(conflict);
    const result = await files.start(engine).done;
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.trim());
    assert.equal(await fs.readFile(path.join(files.output, "top10_ctr.csv"), "utf8"), SENTINELS[0]);
    assert.ok((await fs.stat(conflict)).isDirectory());
    const fileAsDirectory = path.join(files.root, "not-a-directory");
    await fs.writeFile(fileAsDirectory, "keep");
    assert.notEqual((await files.start(engine, { reportPath: fileAsDirectory }).done).code, 0);
    assert.equal(await fs.readFile(fileAsDirectory, "utf8"), "keep");
  });

  test(`${engine}: initializes then waits for IPC release and disconnects on completion`, async (t) => {
    const files = await trial(t, inputCsv([row("ready")]));
    const { child, done } = files.start(engine, { ipc: true });
    await ready(child, done);
    assert.deepEqual(await files.reports(), SENTINELS);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await files.reports(), SENTINELS);
    child.send({ type: "release" });
    const result = await done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(child.connected, false);
    const expected = REPORT_HEADER + "ready,100,10,2.00,1,0.1000,2.00\n";
    assert.deepEqual(await files.reports(), [expected, expected]);
  });

  test(`${engine}: bounded preflight does not parse an oversized malformed body before ready`, async (t) => {
    const files = await trial(t, INPUT_HEADER + '"' + "x".repeat(2 * 1024 * 1024));
    const { child, done } = files.start(engine, { ipc: true });
    await ready(child, done);
    assert.deepEqual(await files.reports(), SENTINELS);
    child.send({ type: "release" });
    const result = await done;
    assert.notEqual(result.code, 0);
    assert.deepEqual(await files.reports(), SENTINELS);
  });
}

for (const engine of ["C", "E"]) {
  test(`${engine}: literal bracket input cannot select or validate a matching file`, async (t) => {
    const text = inputCsv([row("EXPECTED")]);
    const files = await trial(t, text);
    const input = path.join(files.root, "sales[1].csv");
    await fs.writeFile(input, text);
    await fs.writeFile(path.join(files.root, "sales1.csv"), inputCsv([row("WRONG_FILE", "900", "90", "99", "9")]));
    const result = await files.start(engine, { inputPath: input }).done;
    assert.equal(result.code, 0, result.stderr);
    const expected = REPORT_HEADER + "EXPECTED,100,10,2.00,1,0.1000,2.00\n";
    assert.deepEqual(await files.reports(), [expected, expected]);

    await fs.writeFile(input, inputCsv([row("invalid", "1", "1", "1", "1", "2025-02-29")]));
    await Promise.all(REPORT_NAMES.map((name, i) => fs.writeFile(path.join(files.output, name), SENTINELS[i])));
    const failure = await files.start(engine, { inputPath: input }).done;
    assert.notEqual(failure.code, 0);
    assert.ok(failure.stderr.trim());
    assert.deepEqual(await files.reports(), SENTINELS);
  });
}
