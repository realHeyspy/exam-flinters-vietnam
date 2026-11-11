const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const ROOT = path.resolve(__dirname, "..");
const BASE = path.join(__dirname, "benchmarks");
const HASH = "91663c2f36c2a334b0e5e639006d8c29c29e013af0c477d80bb931df68870312";
const URL = "https://github.com/duckdb/duckdb/releases/download/v2.0.0/duckdb-cli-windows-amd64.tar.gz";

async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function command(exe, args, options = {}) {
  const result = spawnSync(exe, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) throw new Error(`${exe}: ${result.error || result.stderr || result.status}`);
  return result.stdout.trim();
}
async function setup() {
  const tools = path.join(BASE, "tools");
  await fsp.mkdir(tools, { recursive: true });
  const archive = path.join(tools, "duckdb-cli-windows-amd64.tar.gz");
  if (!fs.existsSync(archive)) {
    const response = await fetch(URL);
    if (!response.ok) throw new Error(`CLI download: HTTP ${response.status}`);
    const temporary = `${archive}.${crypto.randomUUID()}.tmp`;
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: "wx" }));
      if (await digest(temporary) !== HASH) throw new Error("CLI archive SHA-256 mismatch");
      await fsp.rename(temporary, archive);
    } finally { await fsp.rm(temporary, { force: true }); }
  }
  if (await digest(archive) !== HASH) throw new Error("Existing CLI archive SHA-256 mismatch");
  const extracted = path.join(tools, "duckdb-2.0.0");
  await fsp.mkdir(extracted, { recursive: true });
  command("tar", ["-xf", archive, "-C", extracted]);
  const entries = await fsp.readdir(extracted, { recursive: true });
  const binaries = entries.filter((name) => path.basename(name).toLowerCase() === "duckdb.exe");
  if (binaries.length !== 1) throw new Error(`Expected exactly one duckdb.exe, found ${binaries.length}`);
  const cli = path.join(extracted, binaries[0]);
  const cliVersion = command(cli, ["-version"]);
  const cliProbe = command(cli, ["-no-init", "-batch", "-bail", "-csv", ":memory:", "SELECT version() AS version, 1 AS probe;"]);
  const { DuckDBInstance } = require("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  let embeddedVersion;
  try {
    const reader = await connection.runAndReadAll("SELECT version() AS version, 1 AS probe");
    const row = reader.getRowObjects()[0];
    if (row.probe !== 1) throw new Error("Embedded SELECT 1 failed");
    embeddedVersion = row.version;
  } finally { connection.closeSync(); instance.closeSync(); }
  if (embeddedVersion !== "v2.0.0" || !cliVersion.startsWith("v2.0.0 ") || !cliProbe.includes("v2.0.0,1")) {
    throw new Error(`DuckDB version/probe mismatch: ${JSON.stringify({ embeddedVersion, cliVersion, cliProbe })}`);
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  let sqliteVersion;
  try { sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version; } finally { db.close(); }
  const versions = { cli, cliVersion, embeddedVersion, sqliteVersion, archiveSha256: HASH, node: process.version };
  await fsp.writeFile(path.join(tools, "versions.json"), JSON.stringify(versions, null, 2) + "\n");
  return versions;
}

const INPUT_HEADER = "campaign_id,date,impressions,clicks,spend,conversions\n";
const REPORT_HEADER = "campaign_id,total_impressions,total_clicks,total_spend,total_conversions,CTR,CPA\n";
const REPORTS = ["top10_ctr.csv", "top10_cpa.csv"];
function campaign(j) { return `CMP${String(j).padStart(7, "0")}`; }
function values(j, p) {
  return [j % 101 === 0 ? 0 : (p ? 300 : 100) + j % 100,
    j % 101 === 0 ? 0 : j % 10 + p, (p ? 2050 : 1025) + 100 * (j % 97), (p ? 2 : 1) * (j % 5)];
}
function fixtureRow(i, cardinality) {
  const j = i % cardinality;
  const p = Math.floor(i / cardinality) % 2;
  const [impressions, clicks, cents, conversions] = values(j, p);
  return `${campaign(j)},2025-01-0${p + 1},${String(impressions).padStart(8, "0")},${String(clicks).padStart(8, "0")},${String(Math.floor(cents / 100)).padStart(7, "0")}.${String(cents % 100).padStart(2, "0")},${String(conversions).padStart(8, "0")}\n`;
}
function totalsFor(j, rows, cardinality) {
  const n = Math.max(0, Math.floor((rows - 1 - j) / cardinality) + 1);
  const a = values(j, 0), b = values(j, 1);
  return { id: campaign(j), totals: a.map((v, k) => BigInt(v) * BigInt(Math.ceil(n / 2)) + BigInt(b[k]) * BigInt(Math.floor(n / 2))) };
}
function compareReference(a, b, kind) {
  const [ai, ac, as, av] = a.totals;
  const [bi, bc, bs, bv] = b.totals;
  const left = kind === 0 ? (ai === 0n ? 0n : ac) * (bi || 1n) : as * bv;
  const right = kind === 0 ? (bi === 0n ? 0n : bc) * (ai || 1n) : bs * av;
  return left === right ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (left < right ? -1 : 1) * (kind === 0 ? -1 : 1);
}
function fixedRatio(numerator, denominator, places) {
  if (!denominator) return (0).toFixed(places);
  const scale = 10n ** BigInt(places);
  const rounded = (numerator * scale * 2n + denominator) / (2n * denominator);
  return `${rounded / scale}.${String(rounded % scale).padStart(places, "0")}`;
}
function referenceReports(rows, cardinality) {
  const lists = [[], []];
  for (let j = 0; j < Math.min(rows, cardinality); j++) {
    const candidate = totalsFor(j, rows, cardinality);
    for (let kind = 0; kind < 2; kind++) {
      if (kind === 1 && candidate.totals[3] === 0n) continue;
      const list = lists[kind];
      if (list.length === 10 && compareReference(candidate, list[9], kind) >= 0) continue;
      list.push(candidate);
      list.sort((a, b) => compareReference(a, b, kind));
      if (list.length > 10) list.pop();
    }
  }
  return lists.map((list) => REPORT_HEADER + list.map(({ id, totals: [impressions, clicks, cents, conversions] }) =>
    `${id},${impressions},${clicks},${fixedRatio(cents, 100n, 2)},${conversions},${fixedRatio(clicks, impressions, 4)},${conversions ? fixedRatio(cents, conversions * 100n, 2) : ""}\n`).join(""));
}
async function fixture(name, targetBytes, cardinality) {
  const directory = path.join(BASE, "data");
  await fsp.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.csv`);
  const manifestPath = `${file}.json`;
  const rows = Math.floor((targetBytes - Buffer.byteLength(INPUT_HEADER)) / 60);
  if (rows < 0 || !Number.isSafeInteger(targetBytes) || cardinality < 1) throw new Error("Invalid fixture parameters");
  const bytes = Buffer.byteLength(INPUT_HEADER) + rows * 60;
  const references = REPORTS.map((report) => path.join(directory, `${name}.${report}`));
  if (fs.existsSync(file) || fs.existsSync(manifestPath) || references.some((ref) => fs.existsSync(ref))) {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    if (manifest.generator !== 1 || manifest.targetBytes !== targetBytes || manifest.cardinality !== cardinality ||
        manifest.rows !== rows || manifest.bytes !== bytes || (await fsp.stat(file)).size !== bytes || await digest(file) !== manifest.sha256) {
      throw new Error(`Existing fixture conflict: ${file}`);
    }
    const expected = referenceReports(rows, cardinality);
    for (let k = 0; k < 2; k++) if (await fsp.readFile(references[k], "utf8") !== expected[k]) throw new Error(`Reference conflict: ${references[k]}`);
    return { ...manifest, file, references };
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const hash = crypto.createHash("sha256");
  const output = fs.createWriteStream(temporary, { flags: "wx" });
  // shortcut: fixture cycles are periodic; cache at most 4 MiB, not a campaign map.
  const cycleRows = cardinality * 2;
  const cached = cycleRows * 60 <= 4 * 1024 * 1024
    ? Buffer.from(Array.from({ length: cycleRows }, (_, i) => fixtureRow(i, cardinality)).join("")) : null;
  async function* chunks() {
    const header = Buffer.from(INPUT_HEADER);
    hash.update(header);
    yield header;
    let i = 0;
    while (i < rows) {
      let batch;
      if (cached) {
        const count = Math.min(rows - i, cycleRows);
        batch = cached.subarray(0, count * 60);
        i += count;
      } else {
        const count = Math.min(rows - i, Math.floor(4 * 1024 * 1024 / 60));
        batch = Buffer.allocUnsafe(count * 60);
        for (let k = 0; k < count; k++, i++) {
          if (batch.write(fixtureRow(i, cardinality), k * 60, 60, "ascii") !== 60) throw new Error("Fixture row width mismatch");
        }
      }
      hash.update(batch);
      yield batch;
    }
  }
  try {
    await pipeline(Readable.from(chunks()), output);
    if ((await fsp.stat(temporary)).size !== bytes) throw new Error("Fixture byte count mismatch");
    await fsp.rename(temporary, file);
    const expected = referenceReports(rows, cardinality);
    for (let k = 0; k < 2; k++) await fsp.writeFile(references[k], expected[k], { flag: "wx" });
    const manifest = { generator: 1, targetBytes, bytes, rows, cardinality, rowBytes: 60, sha256: hash.digest("hex") };
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    return { ...manifest, file, references };
  } finally { await fsp.rm(temporary, { force: true }); }
}

const os = require("node:os");
const { fork, spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
function secondsSince(start) { return Number(process.hrtime.bigint() - start) / 1e9; }
async function hardware() {
  const disk = await fsp.statfs(ROOT, { bigint: true });
  const windows = JSON.parse(command("powershell.exe", ["-NoProfile", "-Command",
    "$o=Get-CimInstance Win32_OperatingSystem; $c=Get-CimInstance Win32_Processor | Select-Object -First 1; @{os=$o.Caption;freeRamBytes=([double]$o.FreePhysicalMemory*1024);cpu=$c.Name} | ConvertTo-Json -Compress"]));
  return { capturedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    release: os.release(), arch: os.arch(), logicalCpus: os.availableParallelism(), totalRamBytes: os.totalmem(),
    freeDiskBytes: Number(disk.bavail * disk.bsize), ...windows };
}
function profileSettings(engine, profile) {
  return engine === "D"
    ? { cacheSizeKiB: -262144, tempStore: "FILE", journalMode: "DELETE", synchronous: "NORMAL" }
    : { threads: profile === "serial" ? 1 : 8, memoryLimit: profile === "low-memory" ? "512MB" : "2GB",
      maxTempDirectorySize: "50GB", preserveInsertionOrder: false };
}
function killTree(child) {
  if (child && child.exitCode === null) {
    const killed = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
    if (killed.error) console.error(`Process-tree termination: ${killed.error.message}`);
  }
}
async function trial(runDir, workload, engine, profile, repeat, control) {
  const name = `${workload.cardinality}-${engine}-${profile}-${repeat}`;
  const directory = path.join(runDir, name);
  const scratch = path.join(directory, "scratch");
  const reports = path.join(directory, "reports");
  await fsp.mkdir(scratch, { recursive: true });
  await fsp.mkdir(reports);
  const monitorOutput = path.join(directory, "resources.json");
  const stopMarker = path.join(directory, "monitor.stop");
  const versions = JSON.parse(await fsp.readFile(path.join(BASE, "tools", "versions.json"), "utf8"));
  const startedAt = new Date().toISOString();
  const spawnTime = process.hrtime.bigint();
  const runner = fork(path.join(__dirname, "campaign-benchmark-runner.cjs"),
    [engine, workload.file, reports, scratch, profile], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  control.runner = runner;
  let stdout = "", stderr = "", monitorStderr = "", readyTime, releaseTime, closeTime;
  let timedOut = false, monitor, resource, error;
  runner.stdout.on("data", (chunk) => { stdout += chunk; });
  runner.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => {
    runner.once("error", (err) => { error = err.message; });
    runner.once("close", (code, signal) => { closeTime = process.hrtime.bigint(); resolve({ code, signal }); });
  });
  const ready = new Promise((resolve) => runner.on("message", (message) => {
    if (message.type === "ready") { readyTime = process.hrtime.bigint(); resolve(true); }
  }));
  const deadline = setTimeout(() => { timedOut = true; killTree(runner); }, 60 * 60 * 1000);
  let exit;
  try {
    const initialized = await Promise.race([ready, closed.then(() => false)]);
    if (initialized) {
      monitor = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        path.join(__dirname, "campaign-benchmark-monitor.ps1"), "-RootPid", String(runner.pid),
        "-ScratchPath", scratch, "-OutputPath", monitorOutput, "-StopMarker", stopMarker],
      { stdio: ["ignore", "ignore", "pipe"] });
      control.monitor = monitor;
      monitor.stderr.on("data", (chunk) => { monitorStderr += chunk; });
      const monitorClosed = new Promise((resolve) => {
        monitor.once("error", (err) => { monitorStderr += err.message; resolve(-1); });
        monitor.once("close", resolve);
      });
      const handshakeStart = process.hrtime.bigint();
      while (!fs.existsSync(`${monitorOutput}.ready`)) {
        if (monitor.exitCode !== null || secondsSince(handshakeStart) > 60 || closeTime || control.interrupted) {
          throw new Error(`Monitor handshake failed: ${monitorStderr || "runner closed or 60s deadline"}`);
        }
        await delay(40);
      }
      releaseTime = process.hrtime.bigint();
      runner.send({ type: "release" });
      exit = await closed;
      await fsp.writeFile(stopMarker, "");
      const monitorCode = await Promise.race([monitorClosed, delay(30000).then(() => "timeout")]);
      if (monitorCode !== 0) throw new Error(`Monitor exit ${monitorCode}: ${monitorStderr}`);
      const { elapsedSeconds: monitorElapsedSeconds, ...sampled } = JSON.parse(await fsp.readFile(monitorOutput, "utf8"));
      resource = { ...sampled, monitorElapsedSeconds };
      if (!(resource.samples > 0 && resource.sampledPeakRssBytes > 0) ||
          (engine === "E" && !(resource.descendantSamples > 0))) throw new Error("Missing process-tree resource measurements");
    } else exit = await closed;
  } catch (err) {
    error = err.stack;
    killTree(runner);
    exit = await closed;
    await fsp.writeFile(stopMarker, "").catch(() => {});
    if (monitor && monitor.exitCode === null) killTree(monitor);
  } finally {
    clearTimeout(deadline);
    control.runner = null;
    control.monitor = null;
  }
  const elapsedSeconds = Number(closeTime - spawnTime - (releaseTime ? releaseTime - readyTime : 0n)) / 1e9;
  let status = timedOut ? "timeout" : control.interrupted ? "interrupted" : error || exit.code !== 0 ? "error" : "ok";
  let correctness = "not-checked";
  if (status === "ok") {
    try {
      for (let k = 0; k < 2; k++) {
        const [actual, expected] = await Promise.all([fsp.readFile(path.join(reports, REPORTS[k])), fsp.readFile(workload.references[k])]);
        if (!actual.equals(expected)) throw new Error(`${REPORTS[k]} differs from independent reference`);
      }
      correctness = "byte-identical";
    } catch (err) { correctness = "failed"; status = "error"; error = err.message; }
  }
  const result = { engine, engineVersion: engine === "D" ? versions.sqliteVersion : versions.embeddedVersion,
    profile, settings: profileSettings(engine, profile), repeat, startedAt,
    workload: workload.cardinality, inputBytes: workload.bytes, status, elapsedSeconds,
    throughputMBps: status === "ok" ? workload.bytes / elapsedSeconds / 1e6 : null,
    correctness, ...resource, exit, error, reports, scratch, directory,
    timing: { spawnToCloseSeconds: Number(closeTime - spawnTime) / 1e9,
      excludedHandshakeSeconds: releaseTime ? Number(releaseTime - readyTime) / 1e9 : 0 } };
  await Promise.all([fsp.writeFile(path.join(directory, "trial.json"), JSON.stringify(result, null, 2) + "\n"),
    fsp.writeFile(path.join(directory, "runner.stdout.log"), stdout),
    fsp.writeFile(path.join(directory, "runner.stderr.log"), stderr),
    fsp.writeFile(path.join(directory, "monitor.stderr.log"), monitorStderr)]);
  // Scratch belongs only to this fresh trial; reports, diagnostics and references are retained.
  await fsp.rm(scratch, { recursive: true, force: true });
  console.log(`${name}: ${status}, ${elapsedSeconds.toFixed(3)} s, ${correctness}`);
  return { ...result, diskFull: /ENOSPC|no space left|disk.{0,20}full/i.test(stderr + String(error)) };
}
function summarize(metrics) {
  const rows = [];
  const slowdowns = { C: [], D: [], E: [] };
  for (const workload of metrics.workloads) {
    const group = ["C", "D", "E"].map((engine) => {
      const trials = metrics.trials.filter((t) => t.engine === engine && t.workload === workload.cardinality && t.profile === "main");
      const initial = trials.find((t) => t.repeat === 0);
      const repeats = trials.filter((t) => t.repeat > 0);
      const valid = trials.length === 3 && trials.every((t) => t.status === "ok") && repeats.length === 2;
      const median = valid ? (repeats[0].elapsedSeconds + repeats[1].elapsedSeconds) / 2 : null;
      return { workload: workload.cardinality, engine, initialSeconds: initial?.elapsedSeconds,
        repeatedMedianSeconds: median, repeatedThroughputMBps: median ? workload.bytes / median / 1e6 : null,
        sampledPeakRssBytes: Math.max(0, ...trials.map((t) => t.sampledPeakRssBytes || 0)),
        sampledPeakScratchBytes: Math.max(0, ...trials.map((t) => t.sampledPeakScratchBytes || 0)),
        correctness: trials.length === (metrics.mode === "smoke" ? 1 : 3) && trials.every((t) => t.correctness === "byte-identical")
          ? "byte-identical" : `incomplete/failed: ${trials.map((t) => t.status).join("/") || "not-run"}`,
        valid };
    });
    const fastest = Math.min(...group.filter((r) => r.valid).map((r) => r.repeatedMedianSeconds));
    for (const row of group) {
      if (row.valid) { row.slowdown = row.repeatedMedianSeconds / fastest; slowdowns[row.engine].push(row.slowdown); }
      rows.push(row);
    }
  }
  const ranking = Object.entries(slowdowns).map(([engine, values]) => ({
    engine, geometricMeanSlowdown: values.length === 2 ? Math.sqrt(values[0] * values[1]) : null,
  })).sort((a, b) => (a.geometricMeanSlowdown ?? Infinity) - (b.geometricMeanSlowdown ?? Infinity));
  const best = ranking[0].geometricMeanSlowdown;
  for (const row of ranking) row.effectivelyTiedWithFastest = row.geometricMeanSlowdown !== null && row.geometricMeanSlowdown <= best * 1.05;
  return { main: rows, ranking, diagnostics: metrics.trials.filter((t) => t.profile !== "main") };
}
function markdown(metrics) {
  const f = (n, places = 2) => n == null ? "—" : n.toFixed(places);
  const summary = metrics.summary;
  const lines = ["| Campaigns | Engine | Initial s | Repeat median s | MB/s | Sampled RSS MiB | Sampled scratch MiB | Correctness/status |",
    "|---:|:---:|---:|---:|---:|---:|---:|:---|"];
  for (const r of summary.main) lines.push(`| ${r.workload} | ${r.engine} | ${f(r.initialSeconds)} | ${f(r.repeatedMedianSeconds)} | ${f(r.repeatedThroughputMBps)} | ${f(r.sampledPeakRssBytes / 2 ** 20)} | ${f(r.sampledPeakScratchBytes / 2 ** 20)} | ${r.correctness} |`);
  if (summary.diagnostics.length) {
    lines.push("", "| Engine | Profile | Seconds | MB/s | Sampled RSS MiB | Sampled scratch MiB | Status |", "|:---:|:---|---:|---:|---:|---:|:---|");
    for (const r of summary.diagnostics) lines.push(`| ${r.engine} | ${r.profile} | ${f(r.elapsedSeconds)} | ${f(r.throughputMBps)} | ${f(r.sampledPeakRssBytes / 2 ** 20)} | ${f(r.sampledPeakScratchBytes / 2 ** 20)} | ${r.status}/${r.correctness} |`);
  }
  return lines.join("\n") + "\n";
}
async function benchmark(mode) {
  if (process.platform !== "win32") throw new Error("Resource benchmark requires Windows");
  const snapshot = await hardware();
  if (mode !== "smoke" && snapshot.freeDiskBytes < 100 * 2 ** 30) throw new Error(`Need 100 GiB free disk; found ${snapshot.freeDiskBytes} bytes`);
  const versions = JSON.parse(await fsp.readFile(path.join(BASE, "tools", "versions.json"), "utf8"));
  const runDir = path.join(BASE, "results", `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
  await fsp.mkdir(runDir, { recursive: true });
  const generationStart = process.hrtime.bigint();
  const workloads = [];
  const targetBytes = mode === "full" ? 10000000000 : mode === "1gb" ? 1000000000 : 1000000;
  const definitions = mode === "smoke" ? [["smoke-low", 10], ["smoke-high", 1000]]
    : [[`${mode === "1gb" ? "1gb-" : ""}low-cardinality`, 1000], [`${mode === "1gb" ? "1gb-" : ""}high-cardinality`, 5000000]];
  for (const [name, cardinality] of definitions) {
    console.log(`Preparing ${name}, K=${cardinality}`);
    workloads.push(await fixture(name, targetBytes, cardinality));
  }
  const metrics = { mode, runDir, hardware: snapshot, versions, workloads, generationAndReferenceSeconds: secondsSince(generationStart),
    measurement: { rssIntervalMs: 250, scratchIntervalMs: 1000, description: "Sampled process-tree working set and logical scratch size; monitor outside runner tree; no cache flush; elapsed excludes ready handshake only" },
    trials: [] };
  const metricsPath = path.join(runDir, "metrics.json");
  const save = () => fsp.writeFile(metricsPath, JSON.stringify(metrics, null, 2) + "\n");
  await save();
  const control = { interrupted: false };
  const interrupt = () => { control.interrupted = true; killTree(control.runner); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const schedule = [];
  for (const workload of workloads) {
    const orders = mode !== "smoke" ? [["C", "D", "E"], ["D", "E", "C"], ["E", "C", "D"]] : [["C", "D", "E"]];
    for (let repeat = 0; repeat < orders.length; repeat++) for (const engine of orders[repeat]) schedule.push({ workload, engine, profile: "main", repeat });
  }
  if (mode !== "smoke") for (const profile of ["serial", "low-memory"]) for (const engine of ["C", "E"]) schedule.push({ workload: workloads[1], engine, profile, repeat: 0 });
  try {
    for (let i = 0; i < schedule.length; i++) {
      if (control.interrupted) { metrics.unrun = schedule.slice(i).map(({ engine, profile, workload }) => ({ engine, profile, cardinality: workload.cardinality, reason: "interrupted" })); break; }
      const spec = schedule[i];
      const result = await trial(runDir, spec.workload, spec.engine, spec.profile, spec.repeat, control);
      metrics.trials.push(result);
      await save();
      if (result.diskFull) { metrics.unrun = schedule.slice(i + 1).map(({ engine, profile, workload }) => ({ engine, profile, cardinality: workload.cardinality, reason: "disk-full" })); break; }
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  metrics.summary = summarize(metrics);
  await save();
  await fsp.writeFile(path.join(runDir, "comparison.md"), markdown(metrics));
  console.log(markdown(metrics));
  console.log(`Metrics: ${metricsPath}`);
  if (mode === "smoke" && (metrics.trials.length !== 6 || metrics.trials.some((t) => t.status !== "ok"))) throw new Error(`Smoke failed; inspect ${metricsPath}`);
  return metricsPath;
}

if (require.main === module) {
  const mode = process.argv[2];
  if (!["setup", "smoke", "1gb", "full"].includes(mode)) { console.error("Expected setup, smoke, 1gb, or full"); process.exitCode = 1; }
  else (mode === "setup" ? setup() : benchmark(mode)).then((value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { ROOT, BASE, digest, setup, fixture, fixtureRow, totalsFor, referenceReports, INPUT_HEADER, REPORT_HEADER, REPORTS };
