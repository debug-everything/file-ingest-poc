# Streaming pass-through POC

Can a stateless facade stream a 1 GB file from a partner API to an MFT client without buffering it?
This repo is my test rig for that question. The full spec is in [AGENTS.md](AGENTS.md).

```
MFT client (Python)  ──GET──▶  Facade (Node, node:http + undici)  ──GET──▶  Partner File API (Node)
  writes + fsyncs               streams, samples CPU/mem                     serves pre-generated CSVs
```

It runs two ways: all three pieces locally in Docker, or spread over three networks in the cloud
(GitHub Releases for the files, Railway for the facade, a GitHub Actions runner for the client).

## What you need

Docker Desktop, Node 22, `pnpm`, `uv`, `jq`, and about 1.6 GB of disk for the test files.

## Run it locally

```bash
# 1. Tokens. Any random strings work.
cp .env.example .env
#    then set PARTNER_TOKEN and FACADE_TOKEN, e.g. with: openssl rand -hex 24

# 2. Generate the four test files once (about 25 s). Rerunning skips files that are already good.
cd partner-file-api && pnpm install && pnpm generate && cd ..

# 3. Start the partner (port 8080) and the facade (port 8081, capped at 512 MB / 0.1 CPU).
docker compose up -d --build

# 4. Pull a file through the facade.
cd mft-client
export FACADE_TOKEN=$(grep FACADE_TOKEN ../.env | cut -d= -f2)
uv run python -m mft run --facade-url http://localhost:8081/files/settlement --variant 10mb --out /tmp/settlement.csv
```

Each run prints a report and writes `results/<runId>.json` and `results/<runId>.md`.

Run every scenario from the spec (S0 to S7) and check the pass criteria:

```bash
scripts/scenarios.sh          # all of them, about 4 minutes
scripts/scenarios.sh S0 S4    # or pick some
```

Useful while it runs:

```bash
docker compose logs -f facade     # one JSON line per metric sample
docker compose logs -f partner    # one JSON line per request
docker compose down
```

## MFT client flags

| Flag | What it does |
|---|---|
| `--variant 10mb\|100mb\|500mb\|1gb` | Default `100mb`. `1gb` is always a deliberate choice. |
| `--mode httpx\|curl` | curl mode runs `mft/curl_mode.sh` and captures curl's timing breakdown. |
| `--read-rate-mbps N` | Slow consumer, in megabits per second. |
| `--abort-after-mb N` | Close the connection after N MB. Leaves the partial file in place. |
| `--resume` | Continue a partial `--out` with a `Range` request. |
| `--facade-mode buffer` | Ask the facade to buffer the whole body first (the anti-pattern). |
| `--hwm BYTES` | Override the facade's stream `highWaterMark`. |
| `--warmup` | Wait for facade `/healthz` before starting the clock. |
| `--expected-sha256-from` | `checksums` (default, reads `partner-file-api/checksums.json`), `manifest`, or a hex digest. |

## Env vars

| Service | Var | Default | Notes |
|---|---|---|---|
| partner | `PARTNER_TOKEN` | none, required | Bearer token for everything except `/healthz` |
| partner | `PORT` | `8080` | |
| partner | `DATA_DIR` | `./data` (`/data` in Docker) | Where the CSVs and sidecars live |
| partner | `VARIANTS` | `10mb,100mb,500mb,1gb` | Server won't start if one is missing |
| partner | `DEFAULT_VARIANT` | `100mb` | Used when the lookup has no `variant` |
| partner | `MAX_CONCURRENT_DOWNLOADS` | `2` | Extra streams get `429` |
| partner | `SEED` | `stream-poc-v1` | Generator only. Changing it changes every checksum. |
| facade | `FACADE_TOKEN` | none, required | Bearer token for everything except `/healthz` |
| facade | `PORT` | `8080` | |
| facade | `PARTNER_MODE` | `api` | `api` (local partner) or `static` (manifest on GitHub Releases) |
| facade | `PARTNER_BASE_URL`, `PARTNER_TOKEN` | none | Required in `api` mode |
| facade | `PARTNER_MANIFEST_URL` | none | Required in `static` mode |
| facade | `MANIFEST_TTL_MS` | `300000` | Manifest cache lifetime |
| facade | `PARTNER_ALLOWED_HOSTS` | `github.com,.githubusercontent.com` | `static` mode only. Every hop, redirects included, must match. |
| facade | `METRICS_INTERVAL_MS` | `1000` | |
| facade | `BUFFER_MODE_MAX_BYTES` | `157286400` | Larger files get `413` in `mode=buffer` |
| compose | `PARTNER_HOST_PORT`, `FACADE_HOST_PORT` | `8080`, `8081` | Host ports |
| compose | `FACADE_CPUS` | `0.1` | Facade CPU limit. Try `FACADE_CPUS=1 docker compose up -d facade` to compare. |
| mft | `FACADE_TOKEN` | none | Same as `--token` |

## Local results so far

Docker Desktop on an M3 Pro, facade at 0.1 CPU / 512 MB. Units are decimal (MB = 1e6 bytes).

| Scenario | Variant | Duration | Peak RSS delta | CPU ms/GB | Result |
|---|---|---|---|---|---|
| S1 baseline | 100mb | 10.8 s | 15 MiB | 10,371 | pass |
| S1 baseline | 1gb | 56.3 s | 16 MiB | 5,205 | pass |
| S2 slow consumer (5 MB/s) | 100mb | 21.0 s | 5 MiB | 7,135 | pass, partner stream ran 18.0 s |
| S3 buffer mode | 100mb | 5.1 s | 94 MiB | 4,824 | pass, 500mb refused with 413 |
| S4 abort at 40 MB | 100mb | | | | pass, facade and partner both saw the abort |
| S5 resume | 500mb | | | | pass, partner logged a 206 |
| S6 1gb + 100mb in parallel | 1gb | 62.7 s | under 1 MiB | 5,748 | pass |
| S7 curl | 100mb | 6.6 s | under 1 MiB | 5,773 | pass |

What that says so far: memory stays flat in stream mode no matter the file size, and at 0.1 CPU the
facade is CPU-bound (about 19 MB/s for 1 GB), not network-bound.

## Where I deviated from AGENTS.md

- `pnpm` and `uv` instead of `npm` and `pip`.
- `undici` 7, not 8. Version 8 needs Node 22.19+ and I want the facade to run on my host Node too.
- Backpressure is measured by wrapping `res.write()`, not inside the meter transform. A transform in
  `pipeline()` never sees the return value of `res.write()`.
- The backpressure count alone is useless: every 64 KiB chunk overflows Node's 16 KiB socket buffer, so the
  count is just the chunk count. I added `drainWaitMs` and `drainWaitPct` (time spent waiting for the client
  socket to drain). About 40 to 50% in S1 at 0.1 CPU, 96% in S2. Read it next to `cpuThrottledMs`, because
  a wait that spans a CPU throttle pause gets counted too.
- `--read-rate-mbps` is megabits, matching the partner's `throttle_kbps`. The S2 script uses 40 Mbit/s
  (5 MB/s) so the run takes 21 s instead of nearly 3 minutes.
- No healthcheck on the facade container. A probe process at 0.1 CPU would skew the numbers.
- Redirects are followed by hand instead of with undici's redirect option, so the redirect hop can be
  timed (`redirectMs`) and every hop checked against the host allowlist. Tested from my machine against
  the real release: redirect followed, `Range` gives a `206` after the redirect, no `Content-Encoding`.

## Cloud deploy

| Piece | Host | How it gets there |
|---|---|---|
| Partner | GitHub Release `test-files-v1` (four CSVs + `manifest.json`) | `Publish test files` workflow, run once |
| Facade | Railway, built from `facade-api/Dockerfile` | Railway redeploys on every push to `main` that touches `facade-api/` |
| MFT client | GitHub Actions runner | `MFT run` workflow, triggered by hand |

AGENTS.md says Render for the facade. I switched to Railway: no 0.1 CPU cap, no 5 GB bandwidth cap, no
cold starts, and the whole run plan costs about a dollar of usage.

### One-time setup

1. Publish the files: `gh workflow run publish-test-files.yml`, then check the release has five assets.
2. In Railway: new project, deploy from this GitHub repo, then in the service settings set
   - Root Directory: `/facade-api`
   - Config file path: `/facade-api/railway.json`
   - Variables:
     - `FACADE_TOKEN` = a fresh `openssl rand -hex 24` (not the one from your local `.env`)
     - `PARTNER_MODE` = `static`
     - `PARTNER_MANIFEST_URL` = `https://github.com/debug-everything/file-ingest-poc/releases/download/test-files-v1/manifest.json`
   - Networking: generate a public domain
   - Usage: set a hard usage limit of a few dollars
3. Give the workflow the facade's address and token:
   ```bash
   gh secret set FACADE_URL --body "https://<your-app>.up.railway.app/files/settlement"
   gh secret set FACADE_TOKEN        # paste the same token you gave Railway
   ```

### Run it

```bash
gh workflow run mft-run.yml -f variant=10mb -f scenario=S0-wiring
gh run watch                       # the report lands in the run summary
```

Run order: `10mb` wiring check, then `100mb` until clean, then two or three `1gb` recorded runs.
`1gb` is never the default.

There are no partner logs in the cloud (it's a CDN), so abort and backpressure are judged from the facade's
own numbers: `phase: aborted`, `drainWaitPct`, and `redirectMs` on the `first_byte` sample.

### Egress tally

Railway bills facade egress at about $0.05 per GB. Inbound is free, and GitHub Releases has no bandwidth limit.

| Date | Variant | Scenario | Facade egress | Running total |
|---|---|---|---|---|
| | | | | |

### Cloud results

| Run | Variant | Duration | TTFB | Peak RSS delta | CPU ms/GB | Drain wait % |
|---|---|---|---|---|---|---|
| | | | | | | |

## Not built yet

The optional `--analyze` LLM pass (AGENTS.md section 12).
