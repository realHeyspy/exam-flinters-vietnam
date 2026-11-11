const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { finished } = require("node:stream/promises");
const { DuckDBInstance } = require("@duckdb/node-api");
const {
  REQUIRED, REPORTS, REPORT_HEADER, MAX_RECORD_SIZE, SPACE, header, records, literal, identifier,
  duckdbInputPath, fixedRatio, csvCell, publish,
} = require("./campaign-report-common.cjs");

// shortcut: spend uses 18 fractional places and signed-128-bit units; upgrade for finer or larger amounts.
const MONEY_SCALE = 1000000000000000000n;
const MAX_COUNT = "9223372036854775807";

function ingestion(names) {
  // Positional names keep extra columns and case-folded header spellings distinct.
  const columns = names.map((_, index) => `c${index}`);
  const required = REQUIRED.map((name) => columns[names.indexOf(name)]);
  const [campaign, date, impressions, clicks, spend, conversions] = required.map(identifier);
  const validCounts = [impressions, clicks, conversions].map((column) =>
    `regexp_full_match(${column}, '[0-9]+') AND try_cast(${column} AS BIGINT) BETWEEN 0 AND ${MAX_COUNT}`
  ).join(" AND ");
  const spendUnits = `concat(split_part(${spend}, '.', 1), rpad(split_part(${spend}, '.', 2), 18, '0'))`;
  const validSpend = `regexp_full_match(${spend}, ${literal("[0-9]+(\\.[0-9]+)?")}) AND length(rtrim(split_part(${spend}, '.', 2), '0'))<=18 AND try_cast(${spendUnits} AS HUGEINT)>=0`;
  const validDate = `regexp_full_match(${date}, '[0-9]{4}-[0-9]{2}-[0-9]{2}') AND substr(${date},1,4)<>'0000' AND strftime(try_strptime(${date}, '%Y-%m-%d'), '%Y-%m-%d')=${date}`;
  const source = `read_csv($input, auto_detect=false, max_line_size=${MAX_RECORD_SIZE}, header=true, columns={${columns.map((name) => `${literal(name)}:'VARCHAR'`).join(",")}}, delim=',', quote='"', escape='"', strict_mode=true, ignore_errors=false, null_padding=false, parallel=true, force_not_null=[${required.map(literal).join(",")}])`;
  return `CREATE TABLE totals (
    campaign_id VARCHAR,
    total_impressions BIGINT,
    total_clicks BIGINT,
    spend_units HUGEINT,
    total_conversions BIGINT
  );
  INSERT INTO totals
  SELECT ${campaign}, sum(cast(${impressions} AS BIGINT)), sum(cast(${clicks} AS BIGINT)),
    sum(cast(${spendUnits} AS HUGEINT)), sum(cast(${conversions} AS BIGINT))
  FROM ${source}
  WHERE CASE
    WHEN NOT coalesce(length(trim(${campaign}, ${literal(SPACE)}))>0, false)
      THEN error('Invalid advertising row: campaign_id must not be blank')
    WHEN NOT coalesce(${validDate}, false)
      THEN error('Invalid advertising row: date must be a valid calendar YYYY-MM-DD')
    WHEN NOT coalesce(${validCounts}, false)
      THEN error('Invalid advertising row: counts must be nonnegative integers <= ${MAX_COUNT}')
    WHEN NOT coalesce(${validSpend}, false)
      THEN error('Invalid advertising row: spend must be a nonnegative ordinary decimal with at most 18 nonzero decimal places and <= 170141183460469231731687303715884105727 units of 10^-18 USD')
    ELSE true
  END
  GROUP BY ${campaign};`;
}

function ranking(kind) {
  const columns = "campaign_id,total_impressions,total_clicks,spend_units,total_conversions";
  const ctr = kind === "ctr";
  const numerator = ctr ? "CASE WHEN total_impressions=0 THEN 0::HUGEINT ELSE total_clicks::HUGEINT END" : "spend_units";
  const denominator = ctr ? "CASE WHEN total_impressions=0 THEN 1 ELSE total_impressions END" : "total_conversions";
  const direction = ctr ? "DESC" : "ASC";
  // Two 19-digit remainder chunks distinguish all ratios with signed-64-bit denominators.
  return `WITH ratios AS (
    SELECT ${columns}, ${numerator} AS n, ${denominator} AS d
    FROM totals ${ctr ? "" : "WHERE total_conversions>0"}
  ), chunks AS (
    SELECT *, (n%d)*10000000000000000000::HUGEINT AS scaled FROM ratios
  )
  SELECT ${columns} FROM chunks
  ORDER BY n//d ${direction}, scaled//d ${direction},
    ((scaled%d)*10000000000000000000::HUGEINT)//d ${direction}, campaign_id ASC
  LIMIT 10`;
}

function report(rows) {
  return REPORT_HEADER + rows.map(([id, impressions, clicks, spend, conversions]) => [
    csvCell(id), impressions.toString(), clicks.toString(), fixedRatio(spend, MONEY_SCALE, 2),
    conversions.toString(), impressions === 0n ? "0.0000" : fixedRatio(clicks, impressions, 4),
    conversions === 0n ? "" : fixedRatio(spend, MONEY_SCALE * conversions, 2),
  ].join(",") + "\n").join("");
}

async function protectInput(input, reportDir) {
  const inputReal = await fs.realpath(input);
  let directoryReal;
  try { directoryReal = await fs.realpath(reportDir); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    directoryReal = reportDir;
  }
  for (const name of REPORTS) {
    const destination = path.join(directoryReal, name);
    let destinationReal;
    try { destinationReal = await fs.realpath(destination); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      destinationReal = destination;
    }
    if (path.relative(inputReal, destinationReal) === "") {
      throw new Error(`Input must not be a report destination: ${destination}`);
    }
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error("Usage: node index.js input.csv");
  const input = path.resolve(process.argv[2]);
  const reportDir = path.resolve("result");
  await protectInput(input, reportDir);
  const names = await header(input);
  // DuckDB accepts quotes in unquoted fields; csv-parse enforces strict CSV syntax.
  await finished(records(input).resume(), { cleanup: true });
  const spill = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-reports-"));
  let instance;
  let connection;
  try {
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();
    const settings = `SET threads=8; SET memory_limit='2GB'; SET max_temp_directory_size='50GB'; SET preserve_insertion_order=false; SET temp_directory=${literal(spill)};`;
    const ingestionResult = await connection.run(settings + ingestion(names), { input: duckdbInputPath(input) });
    ingestionResult.closeSync();
    const reports = [];
    for (const kind of ["ctr", "cpa"]) {
      const reader = await connection.runAndReadAll(ranking(kind));
      try { reports.push(report(reader.getRows())); }
      finally { reader.closeSync(); }
    }
    await publish(reportDir, reports);
  } finally {
    try { connection?.closeSync(); }
    finally {
      try { instance?.closeSync(); }
      finally { await fs.rm(spill, { recursive: true, force: true }); }
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
