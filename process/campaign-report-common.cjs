const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { parse } = require("csv-parse");

const REQUIRED = ["campaign_id", "date", "impressions", "clicks", "spend", "conversions"];
const REPORTS = ["top10_ctr.csv", "top10_cpa.csv"];
const REPORT_HEADER = "campaign_id,total_impressions,total_clicks,total_spend,total_conversions,CTR,CPA\n";
// shortcut: records use DuckDB's 2,000,000-byte limit; raise this shared budget if wider CSVs are required.
const MAX_RECORD_SIZE = 2_000_000;
const SPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const identifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
// read_csv expands filename patterns even when its path is bound as a parameter.
const duckdbInputPath = (file) => file.replace(/[\[\]*?]/g, (character) => `[${character}]`);

function records(file, options = {}) {
  const source = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  const parser = parse({ bom: true, max_record_size: MAX_RECORD_SIZE, ...options });
  source.on("error", (error) => parser.destroy(error));
  parser.once("close", () => source.destroy());
  return source.pipe(parser);
}

async function header(file) {
  // Stop after the header even when the following record is malformed or enormous.
  for await (const names of records(file, { to: 1, max_record_size: 1024 * 1024 })) {
    for (const name of REQUIRED) {
      if (names.filter((value) => value === name).length !== 1) throw new Error(`Missing or duplicate required column: ${name}`);
    }
    return names;
  }
  throw new Error("Missing CSV header");
}

function fixedRatio(numerator, denominator, places) {
  const scaled = numerator * 10n ** BigInt(places);
  const rounded = (scaled * 2n + denominator) / (denominator * 2n);
  const digits = rounded.toString().padStart(places + 1, "0");
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function publish(reportDir, reports) {
  await fsp.mkdir(reportDir, { recursive: true });
  const destinations = REPORTS.map((name) => path.join(reportDir, name));
  for (const file of destinations) {
    try { if (!(await fsp.lstat(file)).isFile()) throw new Error(`Report path is not a regular file: ${file}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const staged = destinations.map((file) => `${file}.${randomUUID()}.tmp`);
  try {
    for (let i = 0; i < staged.length; i++) await fsp.writeFile(staged[i], reports[i], { flag: "wx" });
    // Both files are staged first; two renames do not claim crash-atomic publication.
    for (let i = 0; i < staged.length; i++) await fsp.rename(staged[i], destinations[i]);
  } finally { await Promise.all(staged.map((file) => fsp.rm(file, { force: true }))); }
}

module.exports = { REQUIRED, REPORTS, REPORT_HEADER, MAX_RECORD_SIZE, SPACE, literal, identifier, duckdbInputPath, records, header, fixedRatio, csvCell, publish };
