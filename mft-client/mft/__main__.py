"""CLI: python -m mft run --facade-url http://localhost:8081/files/settlement --variant 10mb --out /tmp/s.csv"""

import argparse
import asyncio
import json
import os
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from rich.console import Console
from ulid import ULID

from .download import Options, RunError, run_curl, run_httpx
from .report import build_result, render_markdown

REPO_ROOT = Path(__file__).resolve().parents[2]
TERMINAL_PHASES = {"end", "aborted", "error"}
console = Console()


def parse_args(argv=None):
    p = argparse.ArgumentParser(prog="mft")
    run = p.add_subparsers(dest="cmd", required=True).add_parser("run", help="pull a file through the facade")
    run.add_argument("--facade-url", required=True, help="e.g. http://localhost:8081/files/settlement")
    run.add_argument("--token", default=os.environ.get("FACADE_TOKEN"), help="defaults to $FACADE_TOKEN")
    run.add_argument("--variant", default="100mb", choices=["10mb", "100mb", "500mb", "1gb"])
    run.add_argument("--out", required=True, type=Path)
    run.add_argument(
        "--expected-sha256-from",
        default="checksums",
        help="checksums (repo checksums.json) | manifest | a literal sha256 hex",
    )
    run.add_argument("--manifest-url", default=os.environ.get("PARTNER_MANIFEST_URL"))
    run.add_argument("--scenario", default="S1-baseline")
    run.add_argument("--mode", default="httpx", choices=["httpx", "curl"])
    run.add_argument("--read-rate-mbps", type=float, help="throttle the client, in megabits per second")
    run.add_argument("--abort-after-mb", type=float, help="close the connection after this many MB")
    run.add_argument("--resume", action="store_true", help="continue a partial --out with a Range request")
    run.add_argument("--warmup", action="store_true", help="wait for facade /healthz before the timed run")
    run.add_argument("--facade-mode", default="stream", choices=["stream", "buffer"])
    run.add_argument("--hwm", type=int, help="facade highWaterMark override, in bytes")
    run.add_argument("--results-dir", type=Path, default=REPO_ROOT / "results")
    args = p.parse_args(argv)
    if not args.token:
        p.error("no token: pass --token or set FACADE_TOKEN")
    if args.mode == "curl" and (args.abort_after_mb or args.resume):
        p.error("curl mode does not support --abort-after-mb or --resume")
    return args


def expected_sha256(args) -> str:
    source = args.expected_sha256_from
    if re.fullmatch(r"[0-9a-f]{64}", source):
        return source
    if source == "checksums":
        return json.loads((REPO_ROOT / "partner-file-api" / "checksums.json").read_text())["sha256"][args.variant]
    if source == "manifest":
        if not args.manifest_url:
            raise RunError("--expected-sha256-from manifest needs --manifest-url or PARTNER_MANIFEST_URL")
        manifest = httpx.get(args.manifest_url, follow_redirects=True, timeout=30).raise_for_status().json()
        return manifest["latest"][args.variant]["sha256"]
    raise RunError(f"bad --expected-sha256-from: {source}")


def warmup(origin: httpx.URL) -> dict:
    """Render's free tier sleeps. Wake it before the clock starts."""
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < 120:
        try:
            if httpx.get(origin.join("/healthz"), timeout=30).status_code == 200:
                return {"facadeMs": round((time.perf_counter() - t0) * 1000)}
        except httpx.HTTPError:
            pass
        time.sleep(2)
    raise RunError("facade /healthz never came up")


def fetch_metrics(origin: httpx.URL, token: str, run_id: str) -> list:
    """The facade may still be settling the run (an abort especially), so poll briefly."""
    samples = []
    for _ in range(20):
        resp = httpx.get(
            origin.join(f"/runs/{run_id}/metrics"), headers={"Authorization": f"Bearer {token}"}, timeout=30
        )
        samples = resp.json() if resp.status_code == 200 else []
        if samples and samples[-1]["phase"] in TERMINAL_PHASES:
            break
        time.sleep(0.5)
    return samples


def main(argv=None) -> int:
    args = parse_args(argv)
    run_id = str(ULID())
    params = {"variant": args.variant}
    if args.facade_mode != "stream":
        params["mode"] = args.facade_mode
    if args.hwm:
        params["hwm"] = str(args.hwm)
    url = httpx.URL(args.facade_url).copy_merge_params(params)
    origin = url.copy_with(path="/", query=None)
    opts = Options(
        url=str(url),
        token=args.token,
        run_id=run_id,
        out=args.out,
        read_rate_mbps=args.read_rate_mbps,
        abort_after_mb=args.abort_after_mb,
        resume=args.resume,
    )

    warm = None
    started_at = datetime.now(UTC).isoformat()
    try:
        expected = expected_sha256(args)
        warm = warmup(origin) if args.warmup else None
        started_at = datetime.now(UTC).isoformat()
        client = asyncio.run(run_httpx(opts)) if args.mode == "httpx" else run_curl(opts)
    except (RunError, httpx.HTTPError) as err:
        expected = None
        client = {"error": f"{type(err).__name__}: {err}"}

    result = build_result(
        run_id=run_id,
        scenario=args.scenario,
        mode=args.mode,
        variant=args.variant,
        started_at=started_at,
        client=client,
        expected_sha256=expected,
        warmup=warm,
        samples=fetch_metrics(origin, args.token, run_id),
    )
    markdown = render_markdown(result)

    args.results_dir.mkdir(parents=True, exist_ok=True)
    (args.results_dir / f"{run_id}.json").write_text(json.dumps(result, indent=2) + "\n")
    (args.results_dir / f"{run_id}.md").write_text(markdown)
    if summary_file := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary_file, "a") as f:
            f.write(markdown)
    console.print(markdown, markup=False, highlight=False)
    console.print(f"result: {args.results_dir / f'{run_id}.json'}", markup=False, highlight=False)

    ok = "error" not in client and (client["aborted"] or result["client"]["checksumOk"])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
