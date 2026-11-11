const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { parse: parseSmallCsv } = require("csv-parse/sync");

const { REQUIRED, REPORT_HEADER, MAX_RECORD_SIZE, SPACE, literal, identifier, duckdbInputPath, records, header, fixedRatio, csvCell, publish } = require("../process/campaign-report-common.cjs");
const MAX = Number.MAX_SAFE_INTEGER;

function calendar(value) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function validate(record, indexes) {
  const [campaign, date, impressions, clicks, spend, conversions] = indexes.map((index) => record[index]);
  if (!campaign.trim() || !calendar(date)) throw new Error("Invalid advertising row: campaign/date");
  const texts = [impressions, clicks, spend, conversions];
  const numbers = texts.map(Number);
  if (texts.some((value, index) => !(index === 2 ? /^[0-9]+(?:\.[0-9]+)?$/ : /^[0-9]+$/).test(value)) ||
      numbers.some((value) => !Number.isFinite(value) || value > MAX) ||
      [0, 1, 3].some((index) => !Number.isSafeInteger(numbers[index]))) throw new Error("Invalid advertising row: numeric value/overflow");
  return [campaign, ...numbers];
}

function settings(profile, spill) {
  const threads = profile === "serial" ? 1 : 8;
  const memory = profile === "low-memory" ? "512MB" : "2GB";
  return `SET threads=${threads}; SET memory_limit=${literal(memory)}; SET max_temp_directory_size='50GB'; SET preserve_insertion_order=false; SET temp_directory=${literal(spill)};`;
}

function duckIngestion(file, names, bindPath = false) {
  // Positional synthetic names preserve arbitrary extra/header spellings without SQL name folding.
  const columns = names.map((_, index) => `c${index}`);
  const required = REQUIRED.map((name) => columns[names.indexOf(name)]);
  const [campaign, date, impressions, clicks, spend, conversions] = required.map(identifier);
  const numeric = [impressions, clicks, spend, conversions];
  const validNumeric = numeric.map((column, index) => `regexp_full_match(${column}, ${literal(index === 2 ? '[0-9]+(\\.[0-9]+)?' : '[0-9]+')}) AND try_cast(${column} AS DOUBLE) BETWEEN 0 AND ${MAX}${index === 2 ? '' : ` AND try_cast(${column} AS BIGINT) BETWEEN 0 AND ${MAX}`}`).join(" AND ");
  const validDate = `regexp_full_match(${date}, '[0-9]{4}-[0-9]{2}-[0-9]{2}') AND substr(${date},1,4)<>'0000' AND strftime(try_strptime(${date}, '%Y-%m-%d'), '%Y-%m-%d')=${date}`;
  const source = `read_csv(${bindPath ? "$input" : literal(duckdbInputPath(file))}, auto_detect=false, max_line_size=${MAX_RECORD_SIZE}, header=true, columns={${columns.map((name) => `${literal(name)}:'VARCHAR'`).join(",")}}, delim=',', quote='"', escape='"', strict_mode=true, ignore_errors=false, null_padding=false, parallel=true, force_not_null=[${required.map(literal).join(",")}])`;
  return `CREATE TABLE totals (
    campaign_id VARCHAR,
    total_impressions BIGINT CHECK(total_impressions BETWEEN 0 AND ${MAX}),
    total_clicks BIGINT CHECK(total_clicks BETWEEN 0 AND ${MAX}),
    total_spend DOUBLE CHECK(isfinite(total_spend) AND total_spend BETWEEN 0 AND ${MAX}),
    total_conversions BIGINT CHECK(total_conversions BETWEEN 0 AND ${MAX})
  );
  INSERT INTO totals SELECT ${campaign}, sum(cast(${impressions} AS BIGINT)), sum(cast(${clicks} AS BIGINT)), sum(cast(${spend} AS DOUBLE)), sum(cast(${conversions} AS BIGINT))
  FROM ${source}
  WHERE CASE WHEN length(trim(${campaign}, ${literal(SPACE)}))>0 AND ${validDate} AND ${validNumeric} THEN true ELSE error('Invalid advertising row') END
  GROUP BY ${campaign};`;
}

function ranking(kind, sqlite = false) {
  const columns = "campaign_id,total_impressions,total_clicks,total_spend,total_conversions";
  const ratio = kind === "ctr" ? "CASE WHEN total_impressions=0 THEN 0.0 ELSE 1.0*total_clicks/total_impressions END" : "1.0*total_spend/total_conversions";
  return `SELECT ${columns} FROM totals ${kind === "cpa" ? "WHERE total_conversions>0" : ""} ORDER BY ${ratio} ${kind === "ctr" ? "DESC" : "ASC"}, campaign_id${sqlite ? " COLLATE BINARY" : ""} ASC LIMIT 10`;
}

async function embedded(file, names, scratch, profile) {
  const { DuckDBInstance } = require("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  let connection;
  try {
    connection = await instance.connect();
    await connection.run(settings(profile, path.join(scratch, "duckdb-spill")));
    return {
      async ingest() {
        await connection.run(duckIngestion(file, names, true), { input: duckdbInputPath(file) });
        const rows = [];
        for (const kind of ["ctr", "cpa"]) {
          const result = await connection.runAndReadAll(ranking(kind));
          try { rows.push(result.getRows().map(([id, ...values]) => [id, ...values.map(Number)])); }
          finally { result.closeSync(); }
        }
        return rows;
      },
      close() { connection.closeSync(); instance.closeSync(); }
    };
  } catch (error) { connection?.closeSync(); instance.closeSync(); throw error; }
}

function sqlite(file, names, scratch) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(scratch, `totals-${randomUUID()}.sqlite`));
  try {
    db.exec(`PRAGMA cache_size=-262144; PRAGMA temp_store=FILE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL;
      CREATE TABLE totals (
        campaign_id TEXT PRIMARY KEY COLLATE BINARY,
        total_impressions INTEGER CHECK(typeof(total_impressions)='integer' AND total_impressions BETWEEN 0 AND ${MAX}),
        total_clicks INTEGER CHECK(typeof(total_clicks)='integer' AND total_clicks BETWEEN 0 AND ${MAX}),
        total_spend REAL CHECK(total_spend BETWEEN 0 AND ${MAX}),
        total_conversions INTEGER CHECK(typeof(total_conversions)='integer' AND total_conversions BETWEEN 0 AND ${MAX})
      );`);
    const insert = db.prepare(`INSERT INTO totals VALUES(?,?,?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET
      total_impressions=total_impressions+excluded.total_impressions,
      total_clicks=total_clicks+excluded.total_clicks,
      total_spend=total_spend+excluded.total_spend,
      total_conversions=total_conversions+excluded.total_conversions`);
    const indexes = REQUIRED.map((name) => names.indexOf(name));
    return {
      async ingest() {
        db.exec("BEGIN");
        try {
          let first = true;
          for await (const record of records(file)) {
            if (first) { first = false; continue; }
            insert.run(...validate(record, indexes));
          }
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        return ["ctr", "cpa"].map((kind) => db.prepare(ranking(kind, true)).all().map((row) => [row.campaign_id, row.total_impressions, row.total_clicks, row.total_spend, row.total_conversions]));
      },
      close() { db.close(); }
    };
  } catch (error) { db.close(); throw error; }
}

async function subprocess(file, names, scratch, profile) {
  const versions = JSON.parse(await fsp.readFile(path.join(__dirname, "benchmarks", "tools", "versions.json"), "utf8"));
  if (versions.embeddedVersion !== "v2.0.0" || !versions.cliVersion.startsWith("v2.0.0 ")) throw new Error("Pinned DuckDB version mismatch; run benchmark:setup");
  const child = spawn(versions.cli, ["-no-init", "-batch", "-bail", ":memory:"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdinError;
  child.stdin.on("error", (error) => { stdinError = error; });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const finished = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await once(child, "spawn");
  return {
    async ingest() {
      const outputs = ["ctr", "cpa"].map((kind) => path.join(scratch, `raw-${kind}-${randomUUID()}.csv`));
      const sql = settings(profile, path.join(scratch, "duckdb-spill")) + "\n" + duckIngestion(file, names) + "\n" +
        ["ctr", "cpa"].map((kind, index) => `COPY (${ranking(kind)}) TO ${literal(outputs[index])} (FORMAT CSV, HEADER false);`).join("\n");
      child.stdin.end(sql + "\n");
      const result = await finished;
      if (result.error || result.code !== 0 || stdinError) throw result.error || stdinError || new Error(`DuckDB subprocess exited ${result.code} (${result.signal || "no signal"})`);
      const rows = [];
      for (const output of outputs) {
        rows.push(parseSmallCsv(await fsp.readFile(output, "utf8")).map(([id, ...values]) => [id, ...values.map(Number)]));
      }
      return rows;
    },
    async close() { if (child.exitCode === null && child.signalCode === null) child.kill(); await finished; }
  };
}

function decimalParts(value) {
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = fraction.length - Number(exponent);
  return scale < 0 ? [BigInt(whole + fraction) * 10n ** BigInt(-scale), 1n] : [BigInt(whole + fraction), 10n ** BigInt(scale)];
}

function report(rows) {
  return REPORT_HEADER + rows.map(([id, impressions, clicks, spend, conversions]) => {
    if (![impressions, clicks, conversions].every((value) => Number.isSafeInteger(value) && value >= 0) || !Number.isFinite(spend) || spend < 0 || spend > MAX) throw new Error("Invalid aggregate/overflow");
    // shortcut: REAL spend is exact for quarter-dollar benchmark fixtures, not arbitrary decimal production totals.
    const [amount, scale] = decimalParts(spend);
    return [id, impressions, clicks, fixedRatio(amount, scale, 2), conversions,
      impressions === 0 ? "0.0000" : fixedRatio(BigInt(clicks), BigInt(impressions), 4),
      conversions === 0 ? "" : fixedRatio(amount, scale * BigInt(conversions), 2)].map(csvCell).join(",") + "\n";
  }).join("");
}

async function release() {
  if (!process.send) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { process.off("message", message); process.off("disconnect", disconnected); };
    const message = (value) => { if (value?.type === "release") { cleanup(); resolve(); } };
    const disconnected = () => { cleanup(); reject(new Error("Parent disconnected before release")); };
    process.on("message", message);
    process.once("disconnect", disconnected);
    process.send({ type: "ready" }, (error) => { if (error) { cleanup(); reject(error); } });
  });
}

async function main() {
  const [engine, input, output, temporary, profile] = process.argv.slice(2);
  if (!/^[CDE]$/.test(engine || "") || !input || !output || !temporary || !["main", "serial", "low-memory"].includes(profile)) throw new Error("Usage: runner <C|D|E> <input> <report-dir> <scratch-dir> <main|serial|low-memory>");
  const file = path.resolve(input), reportDir = path.resolve(output), scratch = path.resolve(temporary);
  const names = await header(file);
  await fsp.mkdir(scratch, { recursive: true });
  const pipeline = engine === "C" ? await embedded(file, names, scratch, profile) : engine === "D" ? sqlite(file, names, scratch) : await subprocess(file, names, scratch, profile);
  try {
    await release();
    const results = await pipeline.ingest();
    await publish(reportDir, results.map(report));
  } finally { await pipeline.close(); }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => { if (process.connected) process.disconnect(); });
