# Campaign reports

A Node.js CLI that aggregates campaign metrics across all dates and writes the top ten campaigns by click-through rate (CTR) and cost per acquisition (CPA). Processing uses embedded DuckDB; no database server is required.

## Layout

- `index.js`: root CLI launcher; usage stays `node index.js input.csv`.
- `process/`: production processing and shared CSV/report helpers.
- `test/`: application/logger tests, benchmark tools, and the recorded 1 GB log.
- `test/benchmarks/`: ignored generated fixtures, pinned CLI, benchmark reports, and measurements.
- `.claude/log-prompt.cjs`: shared prompt logger used by all four assistant hooks.
- `input/` and `result/`: original input location and production report output.

## Setup

Requirements:

- Node.js `>=24.14.1 <25` and npm.
- Windows x64 was exercised directly; the Docker image was smoke-tested with Linux containers on Docker Desktop.
- Disk space for the input, reports, and temporary DuckDB spill files. The engine allows up to 50 GB of spill and removes its temporary directory on normal completion or handled errors.

From the project root, install the locked dependencies:

```sh
npm ci
```

Place your CSV at `input/ad_data.csv`, or pass another path. Source datasets, generated benchmark data, dependencies, and IDE files are excluded from Git. `prompts.md` is tracked at the user's request and contains unredacted submitted text; review new entries before future pushes. ZIP extraction, the DuckDB CLI, and benchmark setup are not prerequisites.

## Run

```sh
node index.js input/ad_data.csv
```

Or supply another CSV path (quote paths containing spaces):

```sh
node index.js "path/to/input.csv"
```

Exactly one input path is required. Reports are written under `result/` in the current working directory:

- `top10_ctr.csv`: CTR descending.
- `top10_cpa.csv`: CPA ascending, excluding campaigns with zero total conversions.

Both reports use this header:

```csv
campaign_id,total_impressions,total_clicks,total_spend,total_conversions,CTR,CPA
```

CTR is `total_clicks / total_impressions`, expressed as a ratio rather than a percentage; zero impressions produce `0.0000`. CPA is `total_spend / total_conversions`; zero conversions leave CPA blank in the CTR report. Ranking uses exact values before rounding, with ordinal campaign ID tie-breaking. CTR has four decimal places; spend and CPA have two, using half-up rounding. Fewer than ten eligible campaigns produce fewer rows; a header-only input produces header-only reports.

Existing report files are replaced only after input validation and staging both outputs. Publication is not pairwise crash-atomic: interruption between the two replacements can leave mixed report versions. Source data is never modified. Errors go to stderr and set a nonzero exit code.

### Input format

```csv
campaign_id,date,impressions,clicks,spend,conversions
campaign_a,2026-01-01,1000,50,25.00,5
```

Required columns may be reordered; extra columns are ignored. Required headers must occur exactly once. IDs must be nonblank and are otherwise preserved. Dates must be valid calendar dates in `YYYY-MM-DD` form. Standard CSV quoting, including quoted newlines, is supported.

Counts must be nonnegative integers; each count and campaign total must fit a signed 64-bit integer. Spend must be a nonnegative ordinary decimal, with at most 18 fractional places (additional trailing zeros are accepted). Spend and its totals must fit signed 128-bit units of `10^-18` USD. Malformed CSV, inconsistent field counts, unsupported precision, and overflow are errors. Records are limited to 2,000,000 bytes; the header limit is 1 MiB.

### Tests

```sh
npm test
```

The tests exercise the production CLI, including aggregation, ranking, exact arithmetic, CSV validation, and report preservation, plus the shared prompt logger. No benchmark setup is needed for `npm test`.

Benchmark tools and tests live under `test/`. On Windows, verify their pinned engines and run the small infrastructure checks with:

```sh
npm run benchmark:setup
npm run test:benchmark
npm run benchmark:smoke
```

The optional `npm run benchmark:1gb` command runs the full 1 GB comparison matrix. Generated benchmark artifacts stay under ignored `test/benchmarks/`; existing historical JSON retains paths as they were when measured.

## Docker

Requires Docker with Linux containers (Docker Desktop on Windows). Host Node.js and `npm ci` are not needed for this workflow.

Build from the project root:

```sh
docker build -t campaign-reports:local .
```

Create the host output directory first: `mkdir -p result` in Bash, or `New-Item -ItemType Directory -Force result` in PowerShell. Then run from the project root using Bash on Linux/macOS or PowerShell on Windows:

```sh
docker run --rm --mount "type=bind,source=${PWD}/input,target=/input,readonly" --mount "type=bind,source=${PWD}/result,target=/app/result" campaign-reports:local
```

The default input is `/input/ad_data.csv`. To select another file inside the mounted input directory, append its container path after the image name, for example `campaign-reports:local /input/another.csv`.

The input mount is read-only; both reports persist in the host `result/` directory and replace existing reports under the same rules as the native CLI. The image runs as the non-root `node` user (UID/GID 1000). On Linux, if your output directory belongs to another user, add `--user "$(id -u):$(id -g)"` before the image name.

Only the root CLI launcher, `process/`, and locked dependencies are copied into the image. `.dockerignore` excludes datasets, reports, `test/`, host `node_modules`, and local prompt/configuration files. Temporary spill uses container disk; allow sufficient Docker disk space and RAM beyond the 2 GB engine budget.

Verification after the folder reorganization: the image built successfully and a small CSV smoke test checked exact aggregated/ranked outputs through the host mounts, source preservation, and missing-input failure without replacing existing reports. The approximately 1 GB measurements below are the **recorded native Windows baseline**, not Docker or newly timed folder-layout results.

## Libraries used

| Library | Pinned version | Purpose |
|---|---|---|
| `@duckdb/node-api` | `2.0.0-r.1` | Embedded DuckDB: field validation, aggregation, and exact ranking |
| `csv-parse` | `7.0.3` | Bounded-memory streaming validation of strict CSV syntax |
| Node.js built-ins | Node 24 | File/path handling, temporary storage, and BigInt report formatting |

The CSV syntax validation pass runs before DuckDB reads and aggregates the data. It drains the parser stream directly instead of asynchronously iterating over every record; parser options, size limits, and error handling are unchanged. Only the two small top-ten result sets enter JavaScript for formatting. DuckDB is configured with eight threads and a 2 GB engine memory budget; this is not a hard process RSS cap.

## Processing time and peak memory: approximately 1 GB

Measured on **2026-11-11**, before the folder reorganization, using the production CLI with `input/ad_data.csv`: **1,043,304,870 bytes** (1.043 GB; 994.97 MiB). These historical measurements were not rerun for the file moves.

| Measurement | Recorded baseline |
|---|---:|
| Median end-to-end elapsed time | 51.29 seconds |
| Median CSV validation time | 37.73 seconds |
| Median engine initialization through exit | 13.00 seconds |
| Highest peak process RSS across runs | 284.96 MiB |
| Successful runs | 3 |

Environment: Windows 10 x64 (`10.0.19045`), Node.js `v24.14.1`, AMD Ryzen 9 5900X (24 logical CPUs), 31.89 GiB RAM.

Method: three measured runs of the recorded baseline, with no OS cache flush. No regression tests ran concurrently with timings. A parent Node process measured wall time from immediately before spawning the CLI until child completion, including startup, CSV validation, aggregation, report writing, and cleanup. Detailed run order is recorded in the raw log.

A preload timestamped the call to the full-file parser and the start of DuckDB initialization. The validation interval includes temporary-directory creation immediately after parsing; the engine interval includes initialization, aggregation/ranking, report publication, and cleanup through exit. Stage medians are calculated independently and need not sum to the end-to-end median.

The preload also recorded `process.resourceUsage().maxRSS` at exit. The table reports the highest OS-reported process high-water mark among the three runs, not periodic sampling, heap usage, or the configured DuckDB memory budget. It excludes the parent measurement process.

Runs used temporary working directories and preserved existing repository reports. Report bytes were compared against the first baseline run; source hashes, report SHA-256 hashes, and individual timings are recorded in [`test/benchmark-1gb.json`](test/benchmark-1gb.json). Source hashes retain their original, pre-reorganization paths. At measurement time, production tests passed (85), as did the shared-helper benchmark tests (143). The folder reorganization adds no dependency and changes no validation, arithmetic, ranking, or formatting rules.

These checks do not independently recompute the full dataset's aggregates. Results depend on hardware, cache state, input contents, campaign cardinality, and background activity. Only this approximately 1 GB native Windows workload was timed; no Docker performance or larger-file result is claimed.
