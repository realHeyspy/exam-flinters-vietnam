const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { parse } = require("csv-parse/sync");
const { records } = require("../process/campaign-report-common.cjs");

const APP = path.resolve(__dirname, "..", "index.js");
const INPUT_HEADER = "campaign_id,date,impressions,clicks,spend,conversions\n";
const REPORT_HEADER = "campaign_id,total_impressions,total_clicks,total_spend,total_conversions,CTR,CPA\n";
const REPORTS = ["top10_ctr.csv", "top10_cpa.csv"];
const SENTINELS = ["old CTR report\r\n", "old CPA report\n"];
const MAX64 = 9223372036854775807n;
const MAX_SPEND = "170141183460469231731.687303715884105727";
const cell = (value) => /[",\r\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
const csv = (rows) => INPUT_HEADER + rows.map((values) => values.map(cell).join(",") + "\n").join("");
const row = (id, impressions = "100", clicks = "10", spend = "2.00", conversions = "1", date = "2024-02-29") =>
  [id, date, impressions, clicks, spend, conversions];
const data = (report) => parse(report).slice(1);

async function fixture(t, text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-reports-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "in'put.csv");
  const output = path.join(root, "result");
  await fs.mkdir(output);
  if (text !== null) await fs.writeFile(input, text);
  await Promise.all(REPORTS.map((name, i) => fs.writeFile(path.join(output, name), SENTINELS[i])));
  return {
    root, input, output,
    reports: () => Promise.all(REPORTS.map((name) => fs.readFile(path.join(output, name), "utf8"))),
    run(args = [input]) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [APP, ...args], {
          cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "", stderr = "", timedOut = false;
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          if (timedOut) reject(new Error(`CLI exceeded 60 seconds: ${stderr}`));
          else if (signal) reject(new Error(`CLI terminated by ${signal}: ${stderr}`));
          else resolve({ code, stdout, stderr });
        });
      });
    }
  };
}

async function successful(t, text) {
  const files = await fixture(t, text);
  const result = await files.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await fs.readdir(files.output)).sort(), [...REPORTS].sort(), "only the two requested reports are published");
  const reports = await files.reports();
  for (const report of reports) assert.ok(report.startsWith(REPORT_HEADER), "exact report header");
  return reports;
}

function failed(result) {
  assert.notEqual(result.code, 0, "invalid input must fail");
  assert.ok(result.stderr.trim(), "failure must explain itself on stderr");
}

async function invalid(t, text) {
  const files = await fixture(t, text);
  failed(await files.run());
  assert.deepEqual(await files.reports(), SENTINELS, "validation must preserve both old reports");
}

test("aggregates across dates before calculating ratios rather than averaging rows", async (t) => {
  const reports = await successful(t, csv([
    row("B", "100", "10", "1.00", "1", "2025-01-01"),
    row("A", "000100", "00010", "0002.00", "001"),
    row("B", "900", "0", "9.00", "0", "2025-01-02")
  ]));
  const expected = REPORT_HEADER + "A,100,10,2.00,1,0.1000,2.00\nB,1000,10,10.00,1,0.0100,10.00\n";
  assert.deepEqual(reports, [expected, expected]);
});

test("selects ten of twelve campaigns with ordinal ascending ID ties", async (t) => {
  const ids = ["z", "a", "Z", "A", "aa", "Aa", "aA", "B", "b", "C", "c", "D"];
  const reports = await successful(t, csv(ids.map((id) => row(id))));
  for (const report of reports) {
    assert.equal(data(report).length, 10);
    assert.deepEqual(data(report).map((values) => values[0]), [...ids].sort().slice(0, 10));
  }
});

test("ranks both ratios before formatting identical displayed values", async (t) => {
  const reports = await successful(t, csv([
    row("a-low", "100000", "10000", "10.01", "1000"),
    row("z-high", "100000", "10001", "10.00", "1000")
  ]));
  for (const report of reports) assert.deepEqual(data(report).map((values) => values[0]), ["z-high", "a-low"]);
  assert.deepEqual(data(reports[0]).map((values) => values[5]), ["0.1000", "0.1000"]);
  assert.deepEqual(data(reports[1]).map((values) => values[6]), ["0.01", "0.01"]);
});

test("zero impressions force zero CTR even with clicks and zero conversions are omitted only from CPA", async (t) => {
  const reports = await successful(t, csv([row("zero", "0", "7", "0", "0"), row("paid", "0", "0", "1", "1")]));
  assert.equal(reports[0], REPORT_HEADER + "paid,0,0,1.00,1,0.0000,1.00\nzero,0,7,0.00,0,0.0000,\n");
  assert.equal(reports[1], REPORT_HEADER + "paid,0,0,1.00,1,0.0000,1.00\n");
});

test("header-only input writes two header-only reports", async (t) => {
  assert.deepEqual(await successful(t, INPUT_HEADER), [REPORT_HEADER, REPORT_HEADER]);
});

test("quoted identities retain commas, doubled quotes, CR/LF and surrounding whitespace", async (t) => {
  const id = '  campaign,"quoted"\r\nnext line  ';
  const reports = await successful(t, csv([
    row(id), row(id, "200", "20", "4", "2", "2025-01-01"), row("plain"), row(" plain ")
  ]));
  for (const report of reports) {
    const records = data(report);
    assert.deepEqual(records.map((values) => values[0]), [id, " plain ", "plain"]);
    assert.deepEqual(records[0], [id, "300", "30", "6.00", "3", "0.1000", "2.00"]);
  }
});

test("accepts BOM, reordered columns, extra columns and valid century leap day", async (t) => {
  const text = "\ufeffunused,spend,clicks,campaign_id,conversions,date,impressions\r\nanything,2.00,00010,kept,0001,2000-02-29,00100\r\n";
  const expected = REPORT_HEADER + "kept,100,10,2.00,1,0.1000,2.00\n";
  assert.deepEqual(await successful(t, text), [expected, expected]);
});

test("decimal addition is exact and ties use campaign ID", async (t) => {
  const reports = await successful(t, csv([
    row("a-sum", "1", "1", "0.10", "1"),
    row("a-sum", "1", "1", "0.20", "1"),
    row("z-single", "2", "2", "0.30", "2")
  ]));
  const expected = REPORT_HEADER + "a-sum,2,2,0.30,2,1.0000,0.15\nz-single,2,2,0.30,2,1.0000,0.15\n";
  assert.deepEqual(reports, [expected, expected]);
});

test("money, CPA and CTR round half-up exactly", async (t) => {
  const reports = await successful(t, csv([
    row("half-cent", "32", "1", "0.005", "1"),
    row("half-cpa", "32", "1", "0.75", "10"),
    row("half-spend", "32", "1", "0.075", "1")
  ]));
  const expected = REPORT_HEADER + "half-cent,32,1,0.01,1,0.0313,0.01\nhalf-cpa,32,1,0.75,10,0.0313,0.08\nhalf-spend,32,1,0.08,1,0.0313,0.08\n";
  assert.deepEqual(reports, [expected, expected]);
});

test("CPA ranking retains eighteenth-place subcent differences", async (t) => {
  const reports = await successful(t, csv([
    row("a-costlier", "1", "1", "0.000000000000000002", "1"),
    row("z-cheaper", "1", "1", "0.000000000000000001", "1")
  ]));
  assert.deepEqual(data(reports[1]).map((values) => values[0]), ["z-cheaper", "a-costlier"]);
  for (const values of data(reports[1])) assert.deepEqual([values[3], values[6]], ["0.00", "0.00"]);
});

test("native signed-64-bit aggregates retain every digit through the maximum", async (t) => {
  const reports = await successful(t, csv([
    row("large", String(MAX64 - 1n), String(MAX64 - 1n), "0.1", String(MAX64 - 1n)),
    row("large", "1", "1", "0.2", "1")
  ]));
  const expected = REPORT_HEADER + `large,${MAX64},${MAX64},0.30,${MAX64},1.0000,0.00\n`;
  assert.deepEqual(reports, [expected, expected]);
});

test("CTR ranking distinguishes fractions separated by less than 1e-37", async (t) => {
  const reports = await successful(t, csv([
    row("a-low", String(MAX64 - 1n), String(MAX64 - 2n)),
    row("z-high", String(MAX64), String(MAX64 - 1n))
  ]));
  assert.deepEqual(data(reports[0]).map((values) => values[0]), ["z-high", "a-low"]);
  assert.deepEqual(data(reports[0]).map((values) => values[5]), ["1.0000", "1.0000"]);
});

test("CPA ranking distinguishes adjacent large conversion denominators", async (t) => {
  const reports = await successful(t, csv([
    row("a-costlier", "1", "1", "1", String(MAX64 - 1n)),
    row("z-cheaper", "1", "1", "1", String(MAX64))
  ]));
  assert.deepEqual(data(reports[1]).map((values) => values[0]), ["z-cheaper", "a-costlier"]);
});

test("accepts signed HUGEINT spend boundary and excess fractional trailing zeros", async (t) => {
  const reports = await successful(t, csv([
    row("huge", "1", "1", MAX_SPEND + "000", "1"),
    row("tiny", "1", "1", "0.000000000000000001000000", "1")
  ]));
  const huge = data(reports[0]).find((values) => values[0] === "huge");
  assert.equal(huge[3], "170141183460469231731.69");
  assert.equal(huge[6], "170141183460469231731.69");
  assert.deepEqual(data(reports[1]).map((values) => values[0]), ["tiny", "huge"]);
});

const failures = [
  ["missing required column", "campaign_id,date,impressions,clicks,spend\nA,2025-01-01,1,1,1\n"],
  ["duplicate required name", INPUT_HEADER.trimEnd() + ",date\nA,2025-01-01,1,1,1,1,2025-01-01\n"],
  ["empty file", ""],
  ["missing input file", null],
  ["empty campaign ID", csv([row("")])],
  ["Unicode whitespace-only ID", csv([row(" \t\u00a0\u1680\u2003\u2028\u2029\u202f\u205f\u3000\ufeff\r\n")])],
  ["too few fields", INPUT_HEADER + "A,2025-01-01,1,1,1\n"],
  ["too many fields", INPUT_HEADER + "A,2025-01-01,1,1,1,1,extra\n"],
  ["unterminated quote", INPUT_HEADER + '"A,2025-01-01,1,1,1,1\n'],
  ["quote in unquoted field", INPUT_HEADER + 'A"bad,2025-01-01,1,1,1,1\n'],
  ["text after closing quote", INPUT_HEADER + '"A"junk,2025-01-01,1,1,1,1\n'],
  ["nineteenth nonzero spend place", csv([row("bad", "1", "1", "0.0000000000000000001")])],
  ["HUGEINT row spend overflow", csv([row("bad", "1", "1", "170141183460469231731.687303715884105728")])]
];
for (const date of ["2025-02-29", "1900-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "2024-2-09", "2024-02-9", "2024-02-29T00:00:00", "", " 2024-02-29"]) {
  failures.push([`invalid calendar date ${JSON.stringify(date)}`, csv([row("bad", "1", "1", "1", "1", date)])]);
}
for (const index of [2, 3, 5]) {
  for (const value of ["-1", "1.5", "NaN", "Infinity", "1e2", ""]) {
    const values = row("bad");
    values[index] = value;
    failures.push([`invalid ${INPUT_HEADER.trim().split(",")[index]} ${JSON.stringify(value)}`, csv([values])]);
  }
}
for (const value of ["-0.01", "NaN", "Infinity", "1e2", "", ".5", "1.", "+1", " 1"]) {
  failures.push([`invalid spend ${JSON.stringify(value)}`, csv([row("bad", "1", "1", value)])]);
}

test("invalid inputs fail clearly without replacing either report", async (t) => {
  for (const [name, text] of failures) await t.test(name, (subtest) => invalid(subtest, text));
});

test("count row overflow and aggregate overflow fail even outside either top ten", async (t) => {
  const leaders = Array.from({ length: 12 }, (_, i) => row(`leader-${String(i).padStart(2, "0")}`, "1", "2", "0", "1"));
  for (const index of [2, 3, 5]) {
    await t.test(`row overflow in count column ${index}`, async (subtest) => {
      const bad = row("z-overflow", String(MAX64), "0", "1", "0");
      bad[index] = String(MAX64 + 1n);
      await invalid(subtest, csv([...leaders, bad]));
    });
    await t.test(`aggregate overflow in count column ${index}`, async (subtest) => {
      const first = row("z-overflow", String(MAX64), "0", "1", "0");
      const second = row("z-overflow", "0", "0", "0", "0");
      first[index] = String(MAX64);
      second[index] = "1";
      await invalid(subtest, csv([...leaders, first, second]));
    });
  }
});

test("HUGEINT aggregate spend overflow fails outside the top ten", async (t) => {
  const leaders = Array.from({ length: 12 }, (_, i) => row(`leader-${i}`, "1", "1", "0", "1"));
  await invalid(t, csv([...leaders,
    row("z-overflow", "1", "0", MAX_SPEND, "1"),
    row("z-overflow", "0", "0", "0.000000000000000001", "0")
  ]));
});

test("wrong argument counts fail without touching reports", async (t) => {
  for (const args of [[], ["input.csv", "extra"]]) {
    await t.test(`${args.length} arguments`, async (subtest) => {
      const files = await fixture(subtest, csv([row("valid")]));
      failed(await files.run(args));
      assert.deepEqual(await files.reports(), SENTINELS);
    });
  }
});

test("output path conflicts fail before replacing the other report", async (t) => {
  for (const index of [0, 1]) {
    await t.test(REPORTS[index], async (subtest) => {
      const files = await fixture(subtest, csv([row("valid")]));
      const conflict = path.join(files.output, REPORTS[index]);
      await fs.rm(conflict);
      await fs.mkdir(conflict);
      await fs.writeFile(path.join(conflict, "keep"), "user data");
      failed(await files.run());
      assert.equal(await fs.readFile(path.join(conflict, "keep"), "utf8"), "user data");
      assert.equal(await fs.readFile(path.join(files.output, REPORTS[1 - index]), "utf8"), SENTINELS[1 - index]);
    });
  }
  await t.test("result itself is a file", async (subtest) => {
    const files = await fixture(subtest, csv([row("valid")]));
    await fs.rm(files.output, { recursive: true });
    await fs.writeFile(files.output, "keep result file");
    failed(await files.run());
    assert.equal(await fs.readFile(files.output, "utf8"), "keep result file");
  });
});

test("an input colliding with a report path fails without destroying source bytes", async (t) => {
  const text = csv([row("source")]);
  const files = await fixture(t, text);
  const input = path.join(files.output, REPORTS[0]);
  await fs.writeFile(input, text);
  failed(await files.run([input]));
  assert.equal(await fs.readFile(input, "utf8"), text);
  assert.equal(await fs.readFile(path.join(files.output, REPORTS[1]), "utf8"), SENTINELS[1]);
});

test("bracket filenames and directories stay literal during processing and validation", async (t) => {
  const text = csv([row("EXPECTED")]);
  const files = await fixture(t, text);
  const literalDirectory = path.join(files.root, "source[1]");
  const matchingDirectory = path.join(files.root, "source1");
  await fs.mkdir(literalDirectory);
  await fs.mkdir(matchingDirectory);
  const input = path.join(literalDirectory, "sales[1].csv");
  await fs.writeFile(input, text);
  await fs.writeFile(path.join(matchingDirectory, "sales1.csv"), csv([row("WRONG_FILE", "900", "90", "99", "9")]));
  const result = await files.run([input]);
  assert.equal(result.code, 0, result.stderr);
  const expected = REPORT_HEADER + "EXPECTED,100,10,2.00,1,0.1000,2.00\n";
  assert.deepEqual(await files.reports(), [expected, expected]);

  await fs.writeFile(input, csv([row("invalid", "1", "1", "1", "1", "2025-02-29")]));
  await Promise.all(REPORTS.map((name, i) => fs.writeFile(path.join(files.output, name), SENTINELS[i])));
  failed(await files.run([input]));
  assert.deepEqual(await files.reports(), SENTINELS);
});

test("unterminated oversized records fail at the buffer limit without replacing reports", async (t) => {
  const files = await fixture(t, INPUT_HEADER + '"' + "x".repeat(2_000_010));
  await assert.rejects(async () => {
    for await (const record of records(files.input)) {}
  }, { code: "CSV_MAX_RECORD_SIZE" });
  failed(await files.run());
  assert.deepEqual(await files.reports(), SENTINELS);
});

test("complete records just below the supported size limit still produce reports", async (t) => {
  const id = "x".repeat(1_999_900);
  const reports = await successful(t, csv([row(id)]));
  for (const report of reports) assert.deepEqual(data(report), [[id, "100", "10", "2.00", "1", "0.1000", "2.00"]]);
});
