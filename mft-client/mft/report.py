"""Merge client timings with facade metrics into the result JSON and the Markdown report."""

import os
import socket
from datetime import datetime

MB = 1_000_000
SPARKS = "▁▂▃▄▅▆▇█"


def build_result(*, run_id, scenario, mode, variant, started_at, client, expected_sha256, warmup, samples):
    sha = client.get("sha256")
    client = {
        "host": "github-actions" if os.environ.get("GITHUB_ACTIONS") else socket.gethostname(),
        "startedAt": started_at,
        **client,
        "expectedSha256": expected_sha256,
        "checksumOk": (sha == expected_sha256) if sha else None,
        "warmup": warmup,
    }
    if client.get("bytes") and client.get("writeCompleteMs"):
        client["avgMBps"] = round(client["bytes"] / MB / (client["writeCompleteMs"] / 1000), 1)
    summary = next((s["summary"] for s in reversed(samples) if "summary" in s), None)
    return {
        "runId": run_id,
        "scenario": scenario,
        "mode": mode,
        "variant": variant,
        "client": client,
        "facade": {"summary": summary, "samples": samples},
    }


def _mb(n):
    return "n/a" if n is None else f"{n / 1024 / 1024:,.0f} MB"


def _sparkline(values, top, width=40):
    if not values or not top:
        return ""
    step = -(-len(values) // width)  # ceil
    return "".join(SPARKS[min(len(SPARKS) - 1, int(v / top * len(SPARKS)))] for v in values[::step])


def _row(label, start, peak, end, note=""):
    return f"  {label:<18}{start:<10}{peak:<10}{end:<10}{note}".rstrip()


def render_markdown(result: dict) -> str:
    c = result["client"]
    samples = result["facade"]["samples"]
    summary = result["facade"]["summary"] or {}
    started = datetime.fromisoformat(c["startedAt"]).astimezone().strftime("%Y-%m-%d %H:%M %Z")
    partner_mode = samples[0].get("partnerMode", "?") if samples else "?"

    lines = [
        f"Run {result['runId']} · {result['scenario']} · {result['mode']} · {result['variant']} · {started}",
        f"Partner ({partner_mode}) → Facade → MFT ({c['host']})",
        "",
    ]

    if c.get("error"):
        lines.append(f"FAILED: {c['error']}")
    else:
        checksum = {True: "checksum ok", False: "CHECKSUM MISMATCH", None: "checksum n/a"}[c["checksumOk"]]
        secs = c["writeCompleteMs"] / 1000
        size = f"{c['bytes'] / 1024**3:.2f} GiB" if c["bytes"] >= 1024**3 else f"{c['bytes'] / 1024**2:.0f} MiB"
        lines.append(f"End-to-end (trigger → fsync'd)   {secs:.1f} s     {size}    {c.get('avgMBps', 0)} MB/s")
        lines.append(f"TTFB at client                   {c['ttfbMs'] / 1000:.2f} s     {checksum}")
        if c.get("aborted"):
            lines.append("Client aborted the download on purpose")
        if c.get("resumedFrom"):
            lines.append(f"Resumed from byte {c['resumedFrom']:,}")
        if c.get("curl"):
            lines.append("curl timing: " + ", ".join(f"{k}={v}" for k, v in c["curl"].items()))
        if c["warmup"]:
            lines.append(f"Warm-up (not in the numbers above): facade {c['warmup']['facadeMs']} ms")

    if samples:
        first, last = samples[0], samples[-1]

        def col(get):
            vals = [v for v in (get(s) for s in samples) if v is not None]
            return (get(first), max(vals) if vals else None, get(last))

        rss = col(lambda s: s["mem"]["rss"])
        heap = col(lambda s: s["mem"]["heapUsed"])
        cg = col(lambda s: (s.get("cgroup") or {}).get("memCurrent"))
        limit = (first.get("cgroup") or {}).get("memMax")
        peak_cpu = max(s["cpu"]["pctOfOneCoreSinceLast"] for s in samples)
        throttled = summary.get("cpuThrottledMs")
        per_gb = summary.get("cpuMsPerGB")

        lines += [
            "",
            f"Facade ended in phase: {last['phase']}",
            _row("Facade", "start", "peak", "end"),
            _row("RSS", _mb(rss[0]), _mb(rss[1]), _mb(rss[2]), f"(Δ peak +{_mb(rss[1] - rss[0])})"),
            _row("heapUsed", _mb(heap[0]), _mb(heap[1]), _mb(heap[2])),
            _row("cgroup mem", _mb(cg[0]), _mb(cg[1]), _mb(cg[2]), f"(limit {_mb(limit)})"),
            _row(
                "CPU % of 1 core",
                "-",
                f"{peak_cpu:.0f}%",
                "-",
                "" if throttled is None else f"(throttled {throttled / 1000:.1f} s total)",
            ),
            _row("CPU ms per GB", "n/a" if per_gb is None else f"{per_gb:,.0f}", "", ""),
            _row("Backpressure", f"{last['backpressureEvents']:,} waits,", "", "")
            + f" {summary.get('drainWaitMs', 0) / 1000:.1f} s waiting on the client"
            + f" ({summary.get('drainWaitPct', 0)}% of run)",
            "",
            "Mini chart (RSS over time, top = "
            + (f"cgroup limit {_mb(limit)}" if limit else "peak")
            + "):  "
            + _sparkline([s["mem"]["rss"] for s in samples], limit or rss[1]),
        ]
    else:
        lines += ["", "No facade metrics for this run."]

    return "```\n" + "\n".join(lines) + "\n```\n"
