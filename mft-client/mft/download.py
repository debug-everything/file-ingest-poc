"""The two ways to pull a file through the facade: httpx streaming and a curl script."""

import asyncio
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

CHUNK = 65536
MB = 1_000_000
TIMEOUT = httpx.Timeout(connect=10, read=60, write=60, pool=10)


class RunError(Exception):
    pass


@dataclass
class Options:
    url: str
    token: str
    run_id: str
    out: Path
    read_rate_mbps: float | None = None  # megabits per second
    abort_after_mb: float | None = None
    resume: bool = False


def _headers(o: Options) -> dict[str, str]:
    return {"Authorization": f"Bearer {o.token}", "X-Run-Id": o.run_id, "Accept-Encoding": "identity"}


def _ms(t0: int, t1: int) -> float:
    return round((t1 - t0) / 1e6, 1)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


async def run_httpx(o: Options) -> dict:
    headers = _headers(o)
    offset = o.out.stat().st_size if o.resume and o.out.exists() else 0
    if offset:
        headers["Range"] = f"bytes={offset}-"
    abort_at = int(o.abort_after_mb * MB) if o.abort_after_mb else None
    bytes_per_sec = o.read_rate_mbps * MB / 8 if o.read_rate_mbps else None

    hasher = hashlib.sha256()
    written = 0
    first_byte_ns = None
    aborted = False

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        t0 = time.perf_counter_ns()
        async with client.stream("GET", o.url, headers=headers) as resp:
            ttfb_ns = time.perf_counter_ns()
            if resp.status_code != (206 if offset else 200):
                body = (await resp.aread())[:300].decode(errors="replace")
                raise RunError(f"facade returned {resp.status_code}: {body}")
            if "content-encoding" in resp.headers:
                raise RunError(f"response has Content-Encoding: {resp.headers['content-encoding']}")
            if offset and not resp.headers.get("content-range", "").startswith(f"bytes {offset}-"):
                raise RunError(f"unexpected Content-Range: {resp.headers.get('content-range')}")
            expected = int(resp.headers["content-length"])

            with o.out.open("ab" if offset else "wb") as f:
                async for chunk in resp.aiter_raw(CHUNK):
                    if first_byte_ns is None:
                        first_byte_ns = time.perf_counter_ns()
                    f.write(chunk)
                    hasher.update(chunk)
                    written += len(chunk)
                    if abort_at and written >= abort_at:
                        aborted = True
                        break
                    if bytes_per_sec:
                        ahead = written / bytes_per_sec - (time.perf_counter_ns() - first_byte_ns) / 1e9
                        if ahead > 0:
                            await asyncio.sleep(ahead)
                f.flush()
                os.fsync(f.fileno())
        # Leaving the stream block closes the response, which is what aborts the transfer early.
        t_done = time.perf_counter_ns()

    if not aborted and written != expected:
        raise RunError(f"wrote {written} bytes but Content-Length was {expected}")

    return {
        "status": resp.status_code,
        "ttfbMs": _ms(t0, ttfb_ns),
        "firstByteMs": _ms(t0, first_byte_ns) if first_byte_ns else None,
        "writeCompleteMs": _ms(t0, t_done),
        "bytes": written,
        "resumedFrom": offset or None,
        "aborted": aborted,
        # A resumed file has to be hashed from disk. Otherwise the running hash is the answer.
        "sha256": None if aborted else (sha256_file(o.out) if offset else hasher.hexdigest()),
    }


def run_curl(o: Options) -> dict:
    script = Path(__file__).with_name("curl_mode.sh")
    limit = f"{int(o.read_rate_mbps * MB / 8)}" if o.read_rate_mbps else ""
    with tempfile.NamedTemporaryFile("r", suffix=".headers") as hdr:
        t0 = time.perf_counter_ns()
        proc = subprocess.run(
            [str(script), o.url, str(o.out), o.run_id, hdr.name, limit],
            env={**os.environ, "FACADE_TOKEN": o.token},
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            raise RunError(f"curl exited {proc.returncode}: {proc.stderr.strip()}")
        # curl does not fsync, so do it here before stopping the clock.
        with o.out.open("rb+") as f:
            os.fsync(f.fileno())
        t_done = time.perf_counter_ns()
        response_headers = hdr.read().lower()

    timing = json.loads(proc.stdout)
    if timing["http_code"] != 200:
        raise RunError(f"facade returned {timing['http_code']}")
    if "content-encoding:" in response_headers:
        raise RunError("response has Content-Encoding")
    length = re.search(r"^content-length:\s*(\d+)", response_headers, re.M)
    if length and int(length.group(1)) != timing["size_download"]:
        raise RunError(f"downloaded {timing['size_download']} bytes but Content-Length was {length.group(1)}")
    keys = [
        "time_namelookup",
        "time_connect",
        "time_appconnect",
        "time_starttransfer",
        "time_total",
        "size_download",
        "speed_download",
    ]
    return {
        "status": 200,
        "ttfbMs": round(timing["time_starttransfer"] * 1000, 1),
        "firstByteMs": None,
        "writeCompleteMs": _ms(t0, t_done),
        "bytes": o.out.stat().st_size,
        "resumedFrom": None,
        "aborted": False,
        "sha256": sha256_file(o.out),
        "curl": {k: timing[k] for k in keys},
    }
